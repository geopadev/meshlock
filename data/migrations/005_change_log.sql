-- Change-briefing foundation: storage for "what the previous agent changed",
-- so the next agent to acquire a path can be briefed before it starts.
--
-- Two coherent additions with OPPOSITE lifecycles, which is why they live in
-- two different places:
--
--   1. locks.content_snapshot — the baseline file content captured at ACQUIRE.
--      It belongs on the lock row because it dies WITH the lock: once the holder
--      releases, the baseline has done its job (the diff has been computed) and
--      goes away with the row. M3.5b wires the capture; this migration only adds
--      the column.
--
--   2. change_log — the recorded change, created at RELEASE. It must OUTLIVE the
--      lock (the whole point is to brief the NEXT acquirer, who shows up after
--      this lock is gone), so it cannot live on the locks row. Hence its own
--      append-only table.
--
-- The runner in db.ts wraps this whole file in one transaction — do NOT add a
-- BEGIN/COMMIT here (that would nest and fight the runner), same as 003/004.

-- Step 1: add the per-lock baseline snapshot. This is a CHEAP IN-PLACE add, NOT
-- a table rebuild like 002/003/004. Those rebuilt the table because they changed
-- a multi-column UNIQUE constraint, which SQLite cannot alter in place. Adding a
-- plain NULLABLE column with no default is just a metadata change, so a simple
-- ALTER TABLE ... ADD COLUMN suffices.
--
-- NULLABLE with NO DEFAULT on purpose: until M3.5b wires acquire-time capture,
-- the lock engine's INSERT does not list content_snapshot, so every row arrives
-- without one — a legitimately absent snapshot must be allowed. This is the
-- deliberate INVERSE of S1a's repo_root (a non-null identity column where a
-- missing value is a bug worth failing loud over). A missing snapshot is not a
-- bug; it is the normal state for a lock taken before capture exists.
ALTER TABLE locks ADD COLUMN content_snapshot TEXT;

-- Step 2: the append-only change log. A surrogate INTEGER id (not the
-- (repo_root, path, branch) identity that locks uses) because this is a LOG:
-- many rows per path over time is the entire feature, so there is deliberately
-- NO UNIQUE constraint on the identity triple. That accumulated history is what
-- the next acquirer reads.
CREATE TABLE change_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,   -- surrogate key: a log has many rows per identity
  repo_root    TEXT NOT NULL,                       -- repo scoping (S1 discipline) — always filtered first
  path         TEXT NOT NULL,
  branch       TEXT,                                -- nullable, same NULL-means-branchless rule as locks
  session_id   TEXT NOT NULL,                       -- who made the change
  diff         TEXT NOT NULL,                       -- the floor: unified diff (may be "" for a no-op change)
  summary      TEXT,                                -- optional enrichment, agent-supplied at release
  diff_stat    TEXT,                                -- optional headline (e.g. "2 files, +42 -17")
  changed_at   TEXT NOT NULL                        -- ISO-8601 UTC, ms precision — SAME format as lock expiry
);

-- Lookup index matching how getChanges queries: by (repo_root, path, branch).
CREATE INDEX idx_change_log_lookup ON change_log (repo_root, path, branch);
