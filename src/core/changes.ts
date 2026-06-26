import type { MeshLockDatabase } from "./db.js";

/**
 * One recorded change to a path: the diff a single session produced while it
 * held the lock, plus optional human/agent-facing enrichment. Field names are
 * camelCase here (the TypeScript convention) and are mapped to the snake_case
 * `change_log` columns inside this module — callers never see the SQL names.
 *
 * `diff` is the FLOOR: always present (NOT NULL in the schema), even if it is
 * the empty string for a no-op change. `summary` and `diffStat` are ENRICHMENT:
 * optional, nullable, and MeshLock must read fine without them. The `?` on a
 * field is a compile-time "may be absent" — it erases at runtime, so storage
 * still coalesces a missing value to a real SQL NULL (see recordChange).
 */
export interface ChangeRecord {
  repoRoot: string;
  path: string;
  branch: string | null;
  sessionId: string;
  diff: string;
  summary?: string | null;
  diffStat?: string | null;
  changedAt: string;
}

/** Query shape for {@link getChanges}. `branch` and `limit` are optional. */
export interface ChangeQuery {
  repoRoot: string;
  path: string;
  /**
   * Branch filter. THREE distinct behaviours:
   *  - omitted (undefined): no branch filter — every branch's changes for the path.
   *  - a string: only that branch.
   *  - explicit null: only branchless changes (NULL-means-branchless, as in locks).
   */
  branch?: string | null;
  /** Max rows, most-recent-first. Defaults to 10. */
  limit?: number;
}

/** The raw `change_log` row shape, snake_case, exactly as SQLite returns it. */
interface ChangeRow {
  repo_root: string;
  path: string;
  branch: string | null;
  session_id: string;
  diff: string;
  summary: string | null;
  diff_stat: string | null;
  changed_at: string;
}

/** Default number of recent changes returned by {@link getChanges}. */
const DEFAULT_LIMIT = 10;

/** Map a raw snake_case row to the camelCase {@link ChangeRecord} shape. */
function rowToRecord(row: ChangeRow): ChangeRecord {
  return {
    repoRoot: row.repo_root,
    path: row.path,
    branch: row.branch,
    sessionId: row.session_id,
    diff: row.diff,
    summary: row.summary,
    diffStat: row.diff_stat,
    changedAt: row.changed_at,
  };
}

/**
 * Insert one change record. This is PURE STORAGE — it stores whatever it is
 * given, unconditionally, and decides nothing. Whether a change is even worth
 * recording (e.g. skipping an empty diff) is the caller's policy call in M3.5c,
 * not this module's. Keeping storage "dumb" is what lets the policy evolve
 * without touching the table or this function.
 *
 * The `?? null` coalescing matters: better-sqlite3 rejects a bound `undefined`,
 * and an omitted optional field IS `undefined` at runtime (the `?` is gone after
 * compilation). So a missing summary/diffStat must become an explicit SQL NULL.
 */
export function recordChange(db: MeshLockDatabase, record: ChangeRecord): void {
  db.prepare(
    `INSERT INTO change_log
       (repo_root, path, branch, session_id, diff, summary, diff_stat, changed_at)
     VALUES
       (@repo_root, @path, @branch, @session_id, @diff, @summary, @diff_stat, @changed_at)`
  ).run({
    repo_root: record.repoRoot,
    path: record.path,
    branch: record.branch ?? null,
    session_id: record.sessionId,
    diff: record.diff,
    summary: record.summary ?? null,
    diff_stat: record.diffStat ?? null,
    changed_at: record.changedAt,
  });
}

/**
 * Recent changes for a path, most-recent-first, scoped to one repository.
 *
 * Like every read in this project, the WHERE leads with `repo_root = ?` (S1
 * discipline): forgetting it would leak another repository's change history into
 * a briefing — a silent correctness bug. repo_root is a non-null sentinel, so
 * plain `=` is right; branch (when filtered) uses `IS` for null-safety.
 *
 * Ordering is `changed_at DESC, id DESC`: changed_at gives most-recent-first,
 * and id (the autoincrement surrogate) is a deterministic tiebreaker for two
 * changes recorded in the same millisecond, so the order is stable.
 */
export function getChanges(db: MeshLockDatabase, query: ChangeQuery): ChangeRecord[] {
  const limit = query.limit ?? DEFAULT_LIMIT;

  // Build the branch clause conditionally so an omitted branch means "any".
  if (query.branch === undefined) {
    const rows = db
      .prepare<[string, string, number], ChangeRow>(
        `SELECT repo_root, path, branch, session_id, diff, summary, diff_stat, changed_at
         FROM change_log
         WHERE repo_root = ? AND path = ?
         ORDER BY changed_at DESC, id DESC
         LIMIT ?`
      )
      .all(query.repoRoot, query.path, limit);
    return rows.map(rowToRecord);
  }

  // branch is a string OR explicit null — `IS ?` handles both null-safely.
  const rows = db
    .prepare<[string, string, string | null, number], ChangeRow>(
      `SELECT repo_root, path, branch, session_id, diff, summary, diff_stat, changed_at
       FROM change_log
       WHERE repo_root = ? AND path = ? AND branch IS ?
       ORDER BY changed_at DESC, id DESC
       LIMIT ?`
    )
    .all(query.repoRoot, query.path, query.branch, limit);
  return rows.map(rowToRecord);
}
