-- Add a repo_root dimension to locks so a globally-launched MCP server (one
-- `meshlock init` registration for all repos) can scope locks per repository.
-- Lock identity becomes (repo_root, path, branch). SQLite cannot extend a
-- multi-column UNIQUE constraint in place, so we rebuild the table (same pattern
-- as 002).
--
-- The migration runner in db.ts already wraps each migration file in a single
-- transaction, so all four steps commit together or not at all. Do NOT add a
-- BEGIN/COMMIT here — that would nest transactions and fight the runner.

-- Step 1: new table. repo_root is NOT NULL: it is a sentinel (the git repo root,
-- or the file's own directory when not in a repo), never NULL. Keeping it non-null
-- avoids the NULL-uniqueness trap that branch deliberately lives in, so
-- UNIQUE(repo_root, path, branch) behaves normally on the repo_root column.
--
-- The DEFAULT '(unknown)' lets the lock engine — which is NOT updated in this
-- milestone and whose INSERT does not yet list repo_root — keep writing valid
-- rows. S1b/S1c update the engine and the tools to supply a real repo_root; until
-- then new rows fall back to the same sentinel as the backfill below.
CREATE TABLE locks_new (
  repo_root TEXT NOT NULL DEFAULT '(unknown)',
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  branch TEXT,
  UNIQUE(repo_root, path, branch)
);

-- Step 2: copy existing rows. repo_root is NOT NULL, so pre-S1 rows need a value.
-- '(unknown)' is a backfill placeholder for rows that predate repo scoping — in
-- practice there are none (no production data yet). Live rows get a real repo_root
-- from getRepoRoot at acquire time (S1b/S1c).
INSERT INTO locks_new (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
  SELECT '(unknown)', path, session_id, mode, acquired_at, expires_at, branch FROM locks;

-- Step 3: drop the old table.
DROP TABLE locks;

-- Step 4: rename the rebuilt table into place.
ALTER TABLE locks_new RENAME TO locks;
