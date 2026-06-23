import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.js";

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-db-test-"));
  dbPath = join(tempDir, "test.db");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("enables WAL journal mode on the connection", () => {
    const db = openDatabase(dbPath);
    try {
      const row = db.pragma("journal_mode", { simple: true });
      expect(row).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("records all migrations in filename order", () => {
    const db = openDatabase(dbPath);
    try {
      const applied = db
        .prepare("SELECT name, applied_at FROM migrations ORDER BY id")
        .all() as { name: string; applied_at: string }[];

      expect(applied.map((m) => m.name)).toEqual([
        "001_create_locks.sql",
        "002_add_branch_to_locks.sql",
        "003_add_repo_root_to_locks.sql",
        "004_drop_repo_root_default.sql",
      ]);
      // Each applied_at should be a parseable ISO timestamp.
      for (const m of applied) {
        expect(Number.isNaN(Date.parse(m.applied_at))).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("creates the locks table with the post-004 schema (repo_root NOT NULL, no default, three-way uniqueness)", () => {
    const db = openDatabase(dbPath);
    try {
      const columns = db
        .prepare("PRAGMA table_info(locks)")
        .all() as { name: string; notnull: number; pk: number; dflt_value: string | null }[];

      const byName = new Map(columns.map((c) => [c.name, c]));
      // `repo_root` is present alongside the post-002 columns.
      expect([...byName.keys()].sort()).toEqual([
        "acquired_at",
        "branch",
        "expires_at",
        "mode",
        "path",
        "repo_root",
        "session_id",
      ]);

      // Identity lives in the UNIQUE(repo_root, path, branch) index, so no column
      // is flagged as a PRIMARY KEY.
      expect(byName.get("path")!.pk).toBe(0);
      // repo_root is a non-null sentinel; branch stays nullable; the rest NOT NULL.
      expect(byName.get("repo_root")!.notnull).toBe(1);
      // 004 removed the S1a DEFAULT '(unknown)', so a missing repo_root now fails
      // loud instead of being silently absorbed into a fake repo.
      expect(byName.get("repo_root")!.dflt_value).toBeNull();
      expect(byName.get("branch")!.notnull).toBe(0);
      expect(byName.get("session_id")!.notnull).toBe(1);
      expect(byName.get("mode")!.notnull).toBe(1);
      expect(byName.get("acquired_at")!.notnull).toBe(1);
      expect(byName.get("expires_at")!.notnull).toBe(1);

      // A unique index spanning (repo_root, path, branch) exists.
      const indexes = db.prepare("PRAGMA index_list(locks)").all() as {
        name: string;
        unique: number;
      }[];
      const uniqueCols = indexes
        .filter((i) => i.unique === 1)
        .map((i) =>
          (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map(
            (c) => c.name
          )
        );
      expect(uniqueCols).toContainEqual(["repo_root", "path", "branch"]);
    } finally {
      db.close();
    }
  });

  it("does not re-run migrations when the same DB is opened again", () => {
    const first = openDatabase(dbPath);
    let firstAppliedAt: string;
    try {
      firstAppliedAt = (
        first
          .prepare("SELECT applied_at FROM migrations WHERE name = ?")
          .get("001_create_locks.sql") as { applied_at: string }
      ).applied_at;
    } finally {
      first.close();
    }

    const second = openDatabase(dbPath);
    try {
      const rows = second
        .prepare("SELECT applied_at FROM migrations WHERE name = ?")
        .all("001_create_locks.sql") as { applied_at: string }[];

      // Still exactly one row, with the original timestamp untouched.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.applied_at).toBe(firstAppliedAt);
    } finally {
      second.close();
    }
  });
});
