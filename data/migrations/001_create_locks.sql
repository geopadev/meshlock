-- Locks held by sessions over filesystem paths.
-- A path may be a single file or a directory; granularity is decided by the
-- caller (see config.ts `granularity`). The path itself is the lock identity.
CREATE TABLE locks (
  -- The locked path. One row per path => one holder at a time.
  path TEXT PRIMARY KEY,
  -- The session that holds the lock (config.ts `session_id`, a uuid string).
  session_id TEXT NOT NULL,
  -- "exclusive" | "advisory" — matches config.ts `lock_mode`.
  mode TEXT NOT NULL,
  -- ISO-8601 timestamp when the lock was acquired.
  acquired_at TEXT NOT NULL,
  -- ISO-8601 timestamp when the lock expires (acquired_at + lock_timeout).
  expires_at TEXT NOT NULL
);
