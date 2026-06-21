import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

/**
 * A handle to the MeshLock SQLite database. This is just the better-sqlite3
 * `Database` type re-exported under our own name, so other modules
 * (e.g. lock-engine.ts) depend on `MeshLockDatabase` rather than reaching
 * into better-sqlite3 directly.
 */
export type MeshLockDatabase = Database.Database;

/**
 * Directory holding the numbered `.sql` migration files. Resolved relative to
 * this source file so it works whether we run from `src/` (vitest) or the
 * compiled `dist/` tree. Layout: `<repo>/data/migrations`, and this file lives
 * at `<repo>/src/core/db.ts` (or `<repo>/dist/core/db.js`), so we climb two
 * directories to the package root then into `data/migrations`.
 */
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "migrations"
);

/**
 * Open the database at `path`, enable WAL journaling, ensure the migrations
 * bookkeeping table exists, and apply any not-yet-recorded migrations in
 * filename order. Each migration runs inside its own transaction so a failure
 * leaves the database unchanged for that migration.
 *
 * @param path Filesystem path to the SQLite file. Parameterized so tests can
 *   pass a temp path instead of the real `~/.meshlock` location.
 */
export function openDatabase(path: string): MeshLockDatabase {
  const db = new Database(path);
  // WAL = write-ahead logging: better concurrency (readers don't block the
  // writer) and durability characteristics suited to a long-lived daemon.
  db.pragma("journal_mode = WAL");

  ensureMigrationsTable(db);
  runMigrations(db);

  return db;
}

function ensureMigrationsTable(db: MeshLockDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )`
  );
}

function runMigrations(db: MeshLockDatabase): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const isApplied = db.prepare(
    "SELECT 1 FROM migrations WHERE name = ?"
  );
  const recordApplied = db.prepare(
    "INSERT INTO migrations (name, applied_at) VALUES (?, ?)"
  );

  for (const name of files) {
    if (isApplied.get(name)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf-8");

    // One transaction per migration: the schema change and its bookkeeping
    // row commit together, or not at all.
    const apply = db.transaction(() => {
      db.exec(sql);
      recordApplied.run(name, new Date().toISOString());
    });
    apply();
  }
}
