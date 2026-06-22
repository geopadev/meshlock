import type { MeshLockDatabase } from "./db.js";
import { DEFAULT_CROSS_BRANCH_MODE } from "./config.js";

/**
 * Lock mode — the same vocabulary as config.ts `lock_mode` and the `mode`
 * column in 001_create_locks.sql.
 */
export type LockMode = "exclusive" | "advisory";

/**
 * How to treat a path that is locked by another session on a *different* branch.
 * Same vocabulary as config.ts `cross_branch_mode`. The engine never reads
 * config itself — the caller passes the chosen mode in, the same dependency-
 * injection discipline used for the DB handle.
 */
export type CrossBranchMode = "warn" | "block" | "ignore";

/**
 * One row of the `locks` table. Field names mirror the migration columns
 * exactly so the shape can be read straight out of better-sqlite3. `branch` is
 * nullable: NULL means "no branch / not a git repo", and the engine treats two
 * NULL branches as the same logical branch.
 */
export interface Lock {
  path: string;
  session_id: string;
  mode: LockMode;
  acquired_at: string;
  expires_at: string;
  branch: string | null;
}

/** Input to {@link acquireLock}. */
export interface AcquireInput {
  path: string;
  sessionId: string;
  mode: LockMode;
  timeoutSeconds: number;
  /** Git branch the lock belongs to. Omit or pass null for "no branch". */
  branch?: string | null;
  /** How to handle a cross-branch conflict. Defaults to DEFAULT_CROSS_BRANCH_MODE. */
  crossBranchMode?: CrossBranchMode;
}

/**
 * Attached to a successful {@link AcquireResult} when the path is also locked by
 * another session on a different branch and `crossBranchMode` was "warn". The
 * acquire still succeeded; this is advisory information for the caller to relay.
 */
export interface CrossBranchWarning {
  reason: "cross_branch";
  /** The other holder's branch. May be null if that lock is branchless. */
  otherBranch: string | null;
  heldBy: string;
}

/**
 * Result of {@link acquireLock}. A discriminated union on `ok`: the conflict
 * case ("someone else holds it") is an expected outcome, returned as data
 * rather than thrown. Throwing is reserved for programmer errors and DB faults.
 * The success variant may carry a `warning` (cross-branch "warn" mode).
 */
export type AcquireResult =
  | { ok: true; lock: Lock; warning?: CrossBranchWarning }
  | { ok: false; reason: "held"; heldBy: string };

/** Input to {@link releaseLock}. */
export interface ReleaseInput {
  path: string;
  sessionId: string;
}

/** Result of {@link checkLock}: either the current holder, or free. */
export type CheckResult =
  | { held: true; lock: Lock }
  | { held: false };

/** ISO-8601 "now", matching how the migration documents acquired_at/expires_at. */
function nowIso(): string {
  return new Date().toISOString();
}

/** ISO-8601 timestamp `seconds` in the future. */
function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Acquire (or refresh) the lock on `path` for `sessionId`.
 *
 * The check-and-set runs inside a BEGIN IMMEDIATE transaction. IMMEDIATE is
 * required — not the deferred default — because we read the current holder and
 * then conditionally write based on what we read. A deferred transaction takes
 * only a SHARED read lock at BEGIN and upgrades to RESERVED at the first write,
 * which leaves a window where two connections both pass the read, both try to
 * upgrade, and one fails with SQLITE_BUSY mid-decision. IMMEDIATE takes the
 * RESERVED write lock up front, so connections serialize at BEGIN and exactly
 * one performs the whole read-then-write atomically; the other blocks (up to
 * busy_timeout) and then sees the now-committed row.
 */
export function acquireLock(
  db: MeshLockDatabase,
  input: AcquireInput
): AcquireResult {
  const { path, sessionId, mode, timeoutSeconds } = input;
  const branch = input.branch ?? null;
  const crossBranchMode = input.crossBranchMode ?? DEFAULT_CROSS_BRANCH_MODE;

  // `branch IS ?` is null-safe equality: with a NULL bind it becomes `branch IS
  // NULL`, with a string it behaves like `=`. This is why two branchless locks
  // count as the same logical branch even though SQL `=` would never match NULL.
  const selectSame = db.prepare<[string, string | null], Lock>(
    "SELECT path, session_id, mode, acquired_at, expires_at, branch FROM locks WHERE path = ? AND branch IS ?"
  );
  // The mirror: `branch IS NOT ?` is null-safe inequality — a different branch,
  // treating NULL as distinct from any name and from being absent on our side.
  const selectCross = db.prepare<[string, string | null, string, string], Lock>(
    `SELECT path, session_id, mode, acquired_at, expires_at, branch FROM locks
     WHERE path = ? AND branch IS NOT ? AND session_id != ? AND expires_at > ?
     ORDER BY branch`
  );
  const deleteSame = db.prepare("DELETE FROM locks WHERE path = ? AND branch IS ?");
  const insert = db.prepare(
    `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at, branch)
     VALUES (@path, @session_id, @mode, @acquired_at, @expires_at, @branch)`
  );

  const txn = db.transaction((): AcquireResult => {
    const now = nowIso();

    // Same-branch conflict: a live lock on our (path, branch) held by another
    // session is a hard block — unchanged M2 behavior, now branch-scoped.
    const same = selectSame.get(path, branch);
    if (same && same.expires_at > now && same.session_id !== sessionId) {
      return { ok: false, reason: "held", heldBy: same.session_id };
    }

    // Cross-branch: the same path locked by another session on a different
    // branch. The query already filters to live, other-session, other-branch
    // rows; take the first (ordered by branch for determinism).
    let warning: CrossBranchWarning | undefined;
    const otherBranchLock = selectCross.get(path, branch, sessionId, now);
    if (otherBranchLock) {
      if (crossBranchMode === "block") {
        return { ok: false, reason: "held", heldBy: otherBranchLock.session_id };
      }
      if (crossBranchMode === "warn") {
        warning = {
          reason: "cross_branch",
          otherBranch: otherBranchLock.branch,
          heldBy: otherBranchLock.session_id,
        };
      }
      // "ignore": proceed silently.
    }

    // Write our lock. DELETE-then-INSERT rather than ON CONFLICT(path, branch):
    // the UNIQUE(path, branch) index does NOT fire for NULL branches (SQL treats
    // NULLs as distinct), so an upsert would silently insert a duplicate
    // branchless row. Deleting the same-branch row first guarantees exactly one
    // (path, branch) row whether we are creating, refreshing, or replacing an
    // expired lock — and it never touches other branches' rows.
    const lock: Lock = {
      path,
      session_id: sessionId,
      mode,
      acquired_at: now,
      expires_at: futureIso(timeoutSeconds),
      branch,
    };
    deleteSame.run(path, branch);
    insert.run(lock);
    return warning ? { ok: true, lock, warning } : { ok: true, lock };
  });

  // .immediate() runs the transaction body under BEGIN IMMEDIATE.
  return txn.immediate();
}

/**
 * Release the lock on `path`, but only if `sessionId` is the holder. Releasing
 * a lock you don't own (or one that doesn't exist) is a no-op, not an error.
 *
 * @returns true if a row was actually deleted, false otherwise.
 */
export function releaseLock(db: MeshLockDatabase, input: ReleaseInput): boolean {
  const result = db
    .prepare("DELETE FROM locks WHERE path = ? AND session_id = ?")
    .run(input.path, input.sessionId);
  return result.changes > 0;
}

/**
 * Report the current holder of `path`. A lock whose expires_at <= now counts
 * as free.
 */
export function checkLock(db: MeshLockDatabase, path: string): CheckResult {
  const now = nowIso();
  const row = db
    .prepare<[string], Lock>(
      "SELECT path, session_id, mode, acquired_at, expires_at, branch FROM locks WHERE path = ?"
    )
    .get(path);

  if (!row || row.expires_at <= now) {
    return { held: false };
  }
  return { held: true, lock: row };
}

/** Return all currently-held (non-expired) locks. */
export function listLocks(db: MeshLockDatabase): Lock[] {
  const now = nowIso();
  return db
    .prepare<[string], Lock>(
      "SELECT path, session_id, mode, acquired_at, expires_at, branch FROM locks WHERE expires_at > ? ORDER BY path"
    )
    .all(now);
}

/**
 * Delete every lock whose expires_at <= now. Called explicitly by a caller
 * (e.g. on a sweep); it does not schedule itself.
 *
 * @returns the number of stale rows removed.
 */
export function expireStaleLocks(db: MeshLockDatabase): number {
  const result = db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(nowIso());
  return result.changes;
}
