-- Remove the repo_root DEFAULT that 003 added. In S1a the default '(unknown)'
-- let the not-yet-updated engine keep writing rows. As of S1b the engine supplies
-- repo_root explicitly, so the default's only remaining effect would be to
-- SILENTLY absorb a future missing-repo_root bug into a fake '(unknown)' repo.
-- For an identity column that is the worst failure mode, so we drop the default:
-- an INSERT that omits repo_root must now throw (loud failure = correct).
--
-- SQLite cannot drop a column default in place, so we rebuild the table (same
-- pattern as 002/003). The runner wraps this file in one transaction — do NOT add
-- a BEGIN/COMMIT here.

-- Step 1: new table, identical to the post-003 shape EXCEPT repo_root has no
-- DEFAULT. It stays NOT NULL, and uniqueness stays (repo_root, path, branch).
CREATE TABLE locks_new (
  repo_root TEXT NOT NULL,
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  branch TEXT,
  UNIQUE(repo_root, path, branch)
);

-- Step 2: copy every row across. Existing rows already have a repo_root value
-- (from 003), so we copy it directly — no literal/backfill needed this time.
INSERT INTO locks_new (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
  SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch FROM locks;

-- Step 3: drop the old table.
DROP TABLE locks;

-- Step 4: rename the rebuilt table into place.
ALTER TABLE locks_new RENAME TO locks;
