import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "./db.js";
import {
  acquireLock,
  releaseLock,
  checkLock,
  listLocks,
  expireStaleLocks,
} from "./lock-engine.js";

let tempDir: string;
let dbPath: string;
let db: MeshLockDatabase;

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-lock-test-"));
  dbPath = join(tempDir, "test.db");
  db = openDatabase(dbPath);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("conflicts when another live session holds the path (no throw, one row)", () => {
    const a = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.reason).toBe("held");
      expect(b.heldBy).toBe(SESSION_A);
    }

    const rows = db.prepare("SELECT session_id FROM locks").all() as {
      session_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe(SESSION_A);
  });

  it("treats a same-session re-acquire as a refresh (one row, expires_at advances)", () => {
    const first = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 60,
    });
    expect(first.ok).toBe(true);
    const firstExpiry = first.ok ? first.lock.expires_at : "";

    const second = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 3600,
    });
    expect(second.ok).toBe(true);
    const secondExpiry = second.ok ? second.lock.expires_at : "";

    expect(secondExpiry > firstExpiry).toBe(true);

    const rows = db.prepare("SELECT path FROM locks").all();
    expect(rows).toHaveLength(1);
  });

  it("succeeds over an expired lock held by another session", () => {
    // Seed an already-expired lock for A directly.
    db.prepare(
      `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      "/repo/file.ts",
      SESSION_A,
      "exclusive",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:30:00.000Z"
    );

    const b = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.lock.session_id).toBe(SESSION_B);
  });
});

describe("releaseLock", () => {
  it("does not release a lock owned by a different session", () => {
    acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });

    const wrongOwner = releaseLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
    });
    expect(wrongOwner).toBe(false);

    const owner = releaseLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
    });
    expect(owner).toBe(true);

    expect(checkLock(db, "/repo/file.ts").held).toBe(false);
  });

  it("is a no-op for a path that has no lock", () => {
    expect(releaseLock(db, { path: "/nope", sessionId: SESSION_A })).toBe(false);
  });
});

describe("checkLock", () => {
  it("reports a live lock as held and an expired one as free", () => {
    acquireLock(db, {
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "advisory",
      timeoutSeconds: 1800,
    });
    const live = checkLock(db, "/repo/live.ts");
    expect(live.held).toBe(true);
    if (live.held) expect(live.lock.mode).toBe("advisory");

    db.prepare(
      `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      "/repo/stale.ts",
      SESSION_A,
      "exclusive",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:30:00.000Z"
    );
    expect(checkLock(db, "/repo/stale.ts").held).toBe(false);
  });

  it("reports an unknown path as free", () => {
    expect(checkLock(db, "/unknown").held).toBe(false);
  });
});

describe("TTL expiry", () => {
  it("lets a fresh acquire succeed once the previous lock has expired", () => {
    // A short-but-already-past lock: write expires_at in the past for A.
    db.prepare(
      `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      "/repo/file.ts",
      SESSION_A,
      "exclusive",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:00:01.000Z"
    );

    expect(checkLock(db, "/repo/file.ts").held).toBe(false);

    const fresh = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(fresh.ok).toBe(true);
  });
});

describe("listLocks", () => {
  it("returns only non-expired locks", () => {
    acquireLock(db, {
      path: "/repo/live-1.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    acquireLock(db, {
      path: "/repo/live-2.ts",
      sessionId: SESSION_B,
      mode: "advisory",
      timeoutSeconds: 1800,
    });
    db.prepare(
      `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      "/repo/dead.ts",
      SESSION_A,
      "exclusive",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:30:00.000Z"
    );

    const live = listLocks(db);
    expect(live.map((l) => l.path)).toEqual(["/repo/live-1.ts", "/repo/live-2.ts"]);
  });
});

describe("expireStaleLocks", () => {
  it("deletes only expired rows and returns the count removed", () => {
    acquireLock(db, {
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    const seedStale = db.prepare(
      `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    seedStale.run(
      "/repo/dead-1.ts",
      SESSION_A,
      "exclusive",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:30:00.000Z"
    );
    seedStale.run(
      "/repo/dead-2.ts",
      SESSION_B,
      "advisory",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:30:00.000Z"
    );

    const removed = expireStaleLocks(db);
    expect(removed).toBe(2);

    const remaining = db.prepare("SELECT path FROM locks").all() as {
      path: string;
    }[];
    expect(remaining.map((r) => r.path)).toEqual(["/repo/live.ts"]);
  });
});

describe("concurrency", () => {
  it("serializes acquires when two connections contend for the write lock", () => {
    // Two connections to the same DB file. Because better-sqlite3 is
    // synchronous we can't run two acquires literally in parallel, so we
    // reproduce the race deterministically: db2 opens a BEGIN IMMEDIATE and
    // holds the RESERVED write lock, then db tries to acquire. With
    // busy_timeout = 0, db's own BEGIN IMMEDIATE cannot get the write lock and
    // fails fast — proving acquireLock contends at BEGIN (the whole point of
    // IMMEDIATE) rather than silently interleaving its read and write.
    const db2 = openDatabase(dbPath);
    db.pragma("busy_timeout = 0");

    const path = "/repo/contended.ts";
    let winner: string | undefined;
    let loserBlocked = false;

    try {
      // db2 is the winner: take the write lock and commit A's row.
      db2.exec("BEGIN IMMEDIATE");
      db2
        .prepare(
          `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          path,
          SESSION_A,
          "exclusive",
          new Date().toISOString(),
          new Date(Date.now() + 1800 * 1000).toISOString()
        );

      // While db2 holds the write lock, db's acquire must fail to begin.
      try {
        acquireLock(db, {
          path,
          sessionId: SESSION_B,
          mode: "exclusive",
          timeoutSeconds: 1800,
        });
      } catch (err) {
        // better-sqlite3 surfaces the contention as SQLITE_BUSY on err.code.
        loserBlocked = (err as { code?: string }).code === "SQLITE_BUSY";
      }

      db2.exec("COMMIT");
      winner = SESSION_A;
    } finally {
      if (db2.inTransaction) db2.exec("ROLLBACK");
      db2.close();
    }

    // db contended at BEGIN (didn't quietly proceed), and exactly one holder
    // exists — A, the connection that won the write lock.
    expect(loserBlocked).toBe(true);
    expect(winner).toBe(SESSION_A);

    // After A committed, B's retry now sees the live lock and gets a conflict
    // result (not a throw) — exactly one winner overall.
    db.pragma("busy_timeout = 2000");
    const retry = acquireLock(db, {
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.heldBy).toBe(SESSION_A);

    const rows = db.prepare("SELECT session_id FROM locks WHERE path = ?").all(path);
    expect(rows).toHaveLength(1);
  });
});
