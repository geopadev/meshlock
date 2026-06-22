-- Add a branch dimension to locks: the same path can be locked independently on
-- different git branches. SQLite cannot drop a PRIMARY KEY or add a multi-column
-- UNIQUE constraint in place, so we rebuild the table (the standard SQLite
-- table-redefinition pattern).
--
-- The migration runner in db.ts already wraps each migration file in a single
-- transaction, so all four steps below commit together or not at all. Do NOT add
-- a BEGIN/COMMIT here — that would nest transactions and fight the runner.

-- Step 1: new table. `branch` is nullable; NULL means "no branch / not a git
-- repo". Lock identity is now the pair (path, branch) rather than path alone, so
-- the same path can be held once per branch.
CREATE TABLE locks_new (
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  branch TEXT,
  UNIQUE(path, branch)
);

-- Step 2: copy every existing row across. Pre-branch locks become branchless
-- (branch = NULL), which the engine treats as one shared logical branch.
INSERT INTO locks_new (path, session_id, mode, acquired_at, expires_at, branch)
  SELECT path, session_id, mode, acquired_at, expires_at, NULL FROM locks;

-- Step 3: drop the old table.
DROP TABLE locks;

-- Step 4: rename the rebuilt table into place.
ALTER TABLE locks_new RENAME TO locks;
