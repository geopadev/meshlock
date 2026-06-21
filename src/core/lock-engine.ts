import type { MeshLockDatabase } from "./db.js";

/**
 * Lock mode — the same vocabulary as config.ts `lock_mode` and the `mode`
 * column in 001_create_locks.sql.
 */
export type LockMode = "exclusive" | "advisory";

/**
 * One row of the `locks` table. Field names mirror the migration columns
 * exactly so the shape can be read straight out of better-sqlite3.
 */
export interface Lock {
  path: string;
  session_id: string;
  mode: LockMode;
  acquired_at: string;
  expires_at: string;
}

/** Input to {@link acquireLock}. */
export interface AcquireInput {
  path: string;
  sessionId: string;
  mode: LockMode;
  timeoutSeconds: number;
}

/**
 * Result of {@link acquireLock}. A discriminated union on `ok`: the conflict
 * case ("someone else holds it") is an expected outcome, returned as data
 * rather than thrown. Throwing is reserved for programmer errors and DB faults.
 */
export type AcquireResult =
  | { ok: true; lock: Lock }
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

  const selectRow = db.prepare<[string], Lock>(
    "SELECT path, session_id, mode, acquired_at, expires_at FROM locks WHERE path = ?"
  );
  const upsert = db.prepare(
    `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
     VALUES (@path, @session_id, @mode, @acquired_at, @expires_at)
     ON CONFLICT(path) DO UPDATE SET
       session_id = excluded.session_id,
       mode = excluded.mode,
       acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at`
  );

  const txn = db.transaction((): AcquireResult => {
    const now = nowIso();
    const existing = selectRow.get(path);

    // A lock blocks only if it is live (not expired) AND held by someone else.
    if (existing && existing.expires_at > now && existing.session_id !== sessionId) {
      return { ok: false, reason: "held", heldBy: existing.session_id };
    }

    // No row, an expired row, or our own row (refresh): write/replace it.
    const lock: Lock = {
      path,
      session_id: sessionId,
      mode,
      acquired_at: now,
      expires_at: futureIso(timeoutSeconds),
    };
    upsert.run(lock);
    return { ok: true, lock };
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
      "SELECT path, session_id, mode, acquired_at, expires_at FROM locks WHERE path = ?"
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
      "SELECT path, session_id, mode, acquired_at, expires_at FROM locks WHERE expires_at > ? ORDER BY path"
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
