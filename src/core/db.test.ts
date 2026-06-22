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

  it("records both migrations in filename order", () => {
    const db = openDatabase(dbPath);
    try {
      const applied = db
        .prepare("SELECT name, applied_at FROM migrations ORDER BY id")
        .all() as { name: string; applied_at: string }[];

      expect(applied.map((m) => m.name)).toEqual([
        "001_create_locks.sql",
        "002_add_branch_to_locks.sql",
      ]);
      // Each applied_at should be a parseable ISO timestamp.
      for (const m of applied) {
        expect(Number.isNaN(Date.parse(m.applied_at))).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("creates the locks table with the post-002 schema (branch column, composite uniqueness)", () => {
    const db = openDatabase(dbPath);
    try {
      const columns = db
        .prepare("PRAGMA table_info(locks)")
        .all() as { name: string; notnull: number; pk: number }[];

      const byName = new Map(columns.map((c) => [c.name, c]));
      // `branch` is now present alongside the original five columns.
      expect([...byName.keys()].sort()).toEqual([
        "acquired_at",
        "branch",
        "expires_at",
        "mode",
        "path",
        "session_id",
      ]);

      // After the 002 rebuild path is no longer a PRIMARY KEY; identity moved to
      // the UNIQUE(path, branch) index, so no column is flagged as pk.
      expect(byName.get("path")!.pk).toBe(0);
      // branch is nullable; the rest stay NOT NULL.
      expect(byName.get("branch")!.notnull).toBe(0);
      expect(byName.get("session_id")!.notnull).toBe(1);
      expect(byName.get("mode")!.notnull).toBe(1);
      expect(byName.get("acquired_at")!.notnull).toBe(1);
      expect(byName.get("expires_at")!.notnull).toBe(1);

      // A unique index spanning (path, branch) exists.
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
      expect(uniqueCols).toContainEqual(["path", "branch"]);
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
