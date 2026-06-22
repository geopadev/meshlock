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

/** Seed a row directly, bypassing acquireLock — useful for past-expiry rows. */
function seedLock(
  conn: MeshLockDatabase,
  path: string,
  sessionId: string,
  expiresAt: string,
  acquiredAt = "2000-01-01T00:00:00.000Z",
  mode = "exclusive"
): void {
  conn
    .prepare(
      `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(path, sessionId, mode, acquiredAt, expiresAt);
}

function rowCount(conn: MeshLockDatabase, path?: string): number {
  if (path === undefined) {
    return (conn.prepare("SELECT COUNT(*) AS n FROM locks").get() as { n: number }).n;
  }
  return (
    conn.prepare("SELECT COUNT(*) AS n FROM locks WHERE path = ?").get(path) as {
      n: number;
    }
  ).n;
}

describe("acquireLock — conflict", () => {
  it("returns a held conflict when another live session owns the path", () => {
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

    expect(b).toEqual({ ok: false, reason: "held", heldBy: SESSION_A });

    // Exactly one row, still owned by A.
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
    const owner = (
      db.prepare("SELECT session_id FROM locks WHERE path = ?").get("/repo/file.ts") as {
        session_id: string;
      }
    ).session_id;
    expect(owner).toBe(SESSION_A);
  });
});

describe("acquireLock — same-session re-acquire", () => {
  it("refreshes the lock and advances expires_at without adding a row", () => {
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

    // Longer timeout => later expiry. ISO-8601 strings compare chronologically.
    expect(secondExpiry > firstExpiry).toBe(true);
    expect(rowCount(db)).toBe(1);
  });
});

describe("releaseLock — ownership", () => {
  it("only the owning session can release; others are a no-op", () => {
    acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });

    // B does not own it: nothing removed.
    expect(releaseLock(db, { path: "/repo/file.ts", sessionId: SESSION_B })).toBe(false);
    expect(rowCount(db, "/repo/file.ts")).toBe(1);

    // A owns it: removed.
    expect(releaseLock(db, { path: "/repo/file.ts", sessionId: SESSION_A })).toBe(true);
    expect(checkLock(db, "/repo/file.ts").held).toBe(false);
  });

  it("releasing a path with no lock is a no-op returning false", () => {
    expect(releaseLock(db, { path: "/nope", sessionId: SESSION_A })).toBe(false);
  });
});

describe("TTL expiry", () => {
  it("an expired lock reports free and does not block a fresh acquire", () => {
    // Seed an already-expired lock owned by A.
    seedLock(db, "/repo/file.ts", SESSION_A, "2000-01-01T00:00:01.000Z");

    expect(checkLock(db, "/repo/file.ts").held).toBe(false);

    const fresh = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.lock.session_id).toBe(SESSION_B);
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
  });
});

describe("checkLock", () => {
  it("reports a live lock as held with its details", () => {
    acquireLock(db, {
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "advisory",
      timeoutSeconds: 1800,
    });
    const result = checkLock(db, "/repo/live.ts");
    expect(result.held).toBe(true);
    if (result.held) {
      expect(result.lock.session_id).toBe(SESSION_A);
      expect(result.lock.mode).toBe("advisory");
    }
  });

  it("reports an unknown path as free", () => {
    expect(checkLock(db, "/unknown").held).toBe(false);
  });
});

describe("listLocks", () => {
  it("returns only non-expired locks, ordered by path", () => {
    acquireLock(db, {
      path: "/repo/live-b.ts",
      sessionId: SESSION_B,
      mode: "advisory",
      timeoutSeconds: 1800,
    });
    acquireLock(db, {
      path: "/repo/live-a.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    seedLock(db, "/repo/dead.ts", SESSION_A, "2000-01-01T00:30:00.000Z");

    const live = listLocks(db);
    expect(live.map((l) => l.path)).toEqual(["/repo/live-a.ts", "/repo/live-b.ts"]);
  });
});

describe("expireStaleLocks", () => {
  it("deletes only expired rows and returns how many were removed", () => {
    acquireLock(db, {
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    seedLock(db, "/repo/dead-1.ts", SESSION_A, "2000-01-01T00:30:00.000Z");
    seedLock(db, "/repo/dead-2.ts", SESSION_B, "2000-01-01T00:30:00.000Z");

    expect(expireStaleLocks(db)).toBe(2);

    const remaining = listLocks(db).map((l) => l.path);
    expect(remaining).toEqual(["/repo/live.ts"]);
    expect(rowCount(db)).toBe(1);
  });

  it("returns 0 when nothing is expired", () => {
    acquireLock(db, {
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(expireStaleLocks(db)).toBe(0);
    expect(rowCount(db)).toBe(1);
  });
});

describe("acquireLock — branch dimension", () => {
  it("same branch, different session → still hard-blocks", () => {
    const a = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(b).toEqual({ ok: false, reason: "held", heldBy: SESSION_A });
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
  });

  it("cross-branch with crossBranchMode 'warn' → succeeds AND carries a warning", () => {
    acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
      crossBranchMode: "warn",
    });

    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.warning).toEqual({
        reason: "cross_branch",
        otherBranch: "main",
        heldBy: SESSION_A,
      });
    }
    // Both locks coexist: one per branch.
    expect(rowCount(db, "/repo/file.ts")).toBe(2);
  });

  it("cross-branch with crossBranchMode 'block' → hard conflict", () => {
    acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
      crossBranchMode: "block",
    });

    expect(b).toEqual({ ok: false, reason: "held", heldBy: SESSION_A });
    // B never wrote its row.
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
  });

  it("cross-branch with crossBranchMode 'ignore' → succeeds, no warning", () => {
    acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
      crossBranchMode: "ignore",
    });

    expect(b.ok).toBe(true);
    if (b.ok) expect(b.warning).toBeUndefined();
    expect(rowCount(db, "/repo/file.ts")).toBe(2);
  });

  it("two branchless (null) locks on the same path, different sessions → still block", () => {
    // This is the crucial one: UNIQUE(path, branch) will NOT stop two (path,
    // NULL) rows because SQL treats NULL != NULL. The block here is enforced by
    // the engine's selectSame check, not by the database constraint.
    const a = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });
    expect(b).toEqual({ ok: false, reason: "held", heldBy: SESSION_A });
    // Proof the constraint did not silently allow a second branchless row.
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
  });
});

describe("concurrency — two connections to the same DB file", () => {
  it("contends at BEGIN IMMEDIATE: while one holds the write lock the other cannot begin", () => {
    // Two independent connections to the same file.
    const connA = openDatabase(dbPath);
    const connB = openDatabase(dbPath);
    // busy_timeout = 0 => the loser of the write-lock race fails immediately
    // instead of waiting, which lets us observe the contention deterministically.
    connB.pragma("busy_timeout = 0");

    try {
      // connA opens an IMMEDIATE transaction and holds the RESERVED write lock.
      connA.exec("BEGIN IMMEDIATE");
      connA
        .prepare(
          `INSERT INTO locks (path, session_id, mode, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          "/repo/contended.ts",
          SESSION_A,
          "exclusive",
          new Date().toISOString(),
          new Date(Date.now() + 1800 * 1000).toISOString()
        );

      // While A holds the write lock, B's acquireLock cannot even BEGIN IMMEDIATE.
      let code: string | undefined;
      try {
        acquireLock(connB, {
          path: "/repo/contended.ts",
          sessionId: SESSION_B,
          mode: "exclusive",
          timeoutSeconds: 1800,
        });
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      // Proof the connections genuinely serialize through the write lock.
      expect(code).toBe("SQLITE_BUSY");

      connA.exec("COMMIT");
    } finally {
      if (connA.inTransaction) connA.exec("ROLLBACK");
      connA.close();
      connB.close();
    }
  });

  it("produces exactly one winner and one held conflict across two connections", () => {
    const connA = openDatabase(dbPath);
    const connB = openDatabase(dbPath);
    connA.pragma("busy_timeout = 2000");
    connB.pragma("busy_timeout = 2000");

    try {
      const path = "/repo/contended.ts";

      // Two real acquireLock calls from two real connections to the same file.
      // Because better-sqlite3 is synchronous these resolve in order, but each
      // runs its own BEGIN IMMEDIATE against the shared file: the first commits,
      // the second's transaction then reads the committed row and reports held.
      const r1 = acquireLock(connA, {
        path,
        sessionId: SESSION_A,
        mode: "exclusive",
        timeoutSeconds: 1800,
      });
      const r2 = acquireLock(connB, {
        path,
        sessionId: SESSION_B,
        mode: "exclusive",
        timeoutSeconds: 1800,
      });

      const winners = [r1, r2].filter((r) => r.ok);
      const conflicts = [r1, r2].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(conflicts).toHaveLength(1);

      // The conflict names the winner as the holder.
      const conflict = conflicts[0]!;
      const winner = winners[0]!;
      if (!conflict.ok && winner.ok) {
        expect(conflict.heldBy).toBe(winner.lock.session_id);
      }

      // Exactly one row survives, owned by the winner.
      expect(rowCount(connA, path)).toBe(1);
    } finally {
      connA.close();
      connB.close();
    }
  });
});
