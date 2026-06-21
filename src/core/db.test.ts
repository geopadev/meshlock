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

  it("records 001_create_locks as an applied migration", () => {
    const db = openDatabase(dbPath);
    try {
      const applied = db
        .prepare("SELECT name, applied_at FROM migrations ORDER BY id")
        .all() as { name: string; applied_at: string }[];

      expect(applied).toHaveLength(1);
      expect(applied[0]!.name).toBe("001_create_locks.sql");
      // applied_at should be a parseable ISO timestamp.
      expect(Number.isNaN(Date.parse(applied[0]!.applied_at))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("creates the locks table with the expected columns", () => {
    const db = openDatabase(dbPath);
    try {
      const columns = db
        .prepare("PRAGMA table_info(locks)")
        .all() as { name: string; notnull: number; pk: number }[];

      const byName = new Map(columns.map((c) => [c.name, c]));
      expect([...byName.keys()].sort()).toEqual([
        "acquired_at",
        "expires_at",
        "mode",
        "path",
        "session_id",
      ]);

      // path is the primary key.
      expect(byName.get("path")!.pk).toBe(1);
      // The remaining columns are NOT NULL.
      expect(byName.get("session_id")!.notnull).toBe(1);
      expect(byName.get("mode")!.notnull).toBe(1);
      expect(byName.get("acquired_at")!.notnull).toBe(1);
      expect(byName.get("expires_at")!.notnull).toBe(1);
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
