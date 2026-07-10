import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "./db.js";
import {
  acquireLock,
  releaseLock,
  checkLock,
  forceReleaseLock,
  listLocks,
  expireStaleLocks,
} from "./lock-engine.js";

let tempDir: string;
let dbPath: string;
let db: MeshLockDatabase;

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

// A single shared repo for the non-isolation tests: adding repo_root to every
// call must not change the branch/conflict behavior proven in M2/M2.5.
const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";

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
  mode = "exclusive",
  repoRoot = REPO_A,
  branch: string | null = null
): void {
  conn
    .prepare(
      `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(repoRoot, path, sessionId, mode, acquiredAt, expiresAt, branch);
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
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      repoRoot: REPO_A,
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
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 60,
    });
    expect(first.ok).toBe(true);
    const firstExpiry = first.ok ? first.lock.expires_at : "";

    const second = acquireLock(db, {
      repoRoot: REPO_A,
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

describe("acquireLock — content snapshot (M3.5b)", () => {
  const path = "/repo/snap.ts";

  /** Read the stored snapshot for a path straight from the row. */
  function snapshotOf(p: string): string | null {
    return (
      db.prepare("SELECT content_snapshot FROM locks WHERE path = ?").get(p) as {
        content_snapshot: string | null;
      }
    ).content_snapshot;
  }

  it("stores the snapshot passed on an initial acquire", () => {
    const r = acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      contentSnapshot: "ORIGINAL CONTENT",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.content_snapshot).toBe("ORIGINAL CONTENT");
    expect(snapshotOf(path)).toBe("ORIGINAL CONTENT");
  });

  it("preserves the ORIGINAL snapshot across a same-session refresh (keystone)", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 60,
      contentSnapshot: "A",
    });
    // Same session re-acquires (a refresh) with DIFFERENT content. The baseline
    // must NOT move to "B" — it stays the content from the first acquire, so the
    // release-time diff is measured from the true starting point.
    const refresh = acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 3600,
      contentSnapshot: "B",
    });
    expect(refresh.ok).toBe(true);
    if (refresh.ok) expect(refresh.lock.content_snapshot).toBe("A");
    // Still exactly one row (the test-B invariant), still the original baseline.
    expect(rowCount(db, path)).toBe(1);
    expect(snapshotOf(path)).toBe("A");
  });

  it("stores null when no snapshot is provided and does not throw", () => {
    const r = acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.content_snapshot).toBeNull();
    expect(snapshotOf(path)).toBeNull();
  });

  it("captures the new holder's snapshot when taking over an EXPIRED lock (not a refresh)", () => {
    // A's lock is already expired (seeded with no snapshot). B acquiring is a
    // takeover, NOT a same-session refresh, so B's incoming baseline is stored.
    seedLock(db, path, SESSION_A, "2000-01-01T00:00:01.000Z");
    const r = acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      contentSnapshot: "NEW HOLDER",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.content_snapshot).toBe("NEW HOLDER");
    expect(snapshotOf(path)).toBe("NEW HOLDER");
  });
});

describe("releaseLock — ownership", () => {
  it("only the owning session can release; others are a no-op", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });

    // B does not own it: nothing removed, nothing returned.
    expect(
      releaseLock(db, { repoRoot: REPO_A, path: "/repo/file.ts", sessionId: SESSION_B })
    ).toEqual([]);
    expect(rowCount(db, "/repo/file.ts")).toBe(1);

    // A owns it: removed, and the deleted row comes back.
    const deleted = releaseLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.session_id).toBe(SESSION_A);
    expect(checkLock(db, REPO_A, "/repo/file.ts").held).toBe(false);
  });

  it("releasing a path with no lock is a no-op returning []", () => {
    expect(releaseLock(db, { repoRoot: REPO_A, path: "/nope", sessionId: SESSION_A })).toEqual(
      []
    );
  });
});

describe("releaseLock — returns deleted rows (M5.1c)", () => {
  const path = "/repo/released.ts";

  it("returns the deleted row with its branch and baseline snapshot", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
      contentSnapshot: "BASELINE",
    });

    const deleted = releaseLock(db, { repoRoot: REPO_A, path, sessionId: SESSION_A });

    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.branch).toBe("main");
    expect(deleted[0]!.content_snapshot).toBe("BASELINE");
    expect(rowCount(db, path)).toBe(0);
  });

  it("returns ALL of the session's per-branch rows and leaves foreign rows", () => {
    for (const branch of ["main", "feature"]) {
      acquireLock(db, {
        repoRoot: REPO_A,
        path,
        sessionId: SESSION_A,
        mode: "exclusive",
        timeoutSeconds: 1800,
        branch,
        contentSnapshot: `base-${branch}`,
        crossBranchMode: "ignore",
      });
    }
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "theirs",
      crossBranchMode: "ignore",
    });

    const deleted = releaseLock(db, { repoRoot: REPO_A, path, sessionId: SESSION_A });

    // Both of A's branch rows, each with its own baseline; B's row survives.
    expect(deleted.map((l) => l.branch)).toEqual(["feature", "main"]); // ORDER BY branch
    expect(deleted.map((l) => l.content_snapshot)).toEqual(["base-feature", "base-main"]);
    expect(deleted.every((l) => l.session_id === SESSION_A)).toBe(true);
    expect(rowCount(db, path)).toBe(1);
  });

  it("returns an EXPIRED-but-owned row (the caller can still diff its baseline)", () => {
    seedLock(db, path, SESSION_A, "2000-01-01T00:30:00.000Z");

    const deleted = releaseLock(db, { repoRoot: REPO_A, path, sessionId: SESSION_A });

    expect(deleted).toHaveLength(1);
    expect(rowCount(db, path)).toBe(0);
  });
});

describe("TTL expiry", () => {
  it("an expired lock reports free and does not block a fresh acquire", () => {
    // Seed an already-expired lock owned by A.
    seedLock(db, "/repo/file.ts", SESSION_A, "2000-01-01T00:00:01.000Z");

    expect(checkLock(db, REPO_A, "/repo/file.ts").held).toBe(false);

    const fresh = acquireLock(db, {
      repoRoot: REPO_A,
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
      repoRoot: REPO_A,
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "advisory",
      timeoutSeconds: 1800,
    });
    const result = checkLock(db, REPO_A, "/repo/live.ts");
    expect(result.held).toBe(true);
    if (result.held) {
      expect(result.lock.session_id).toBe(SESSION_A);
      expect(result.lock.mode).toBe("advisory");
    }
  });

  it("reports an unknown path as free", () => {
    expect(checkLock(db, REPO_A, "/unknown").held).toBe(false);
  });
});

describe("checkLock — branch filter (M5.1b)", () => {
  const path = "/repo/multi-branch.ts";
  const SESSION_C = "33333333-3333-4333-8333-333333333333";

  /** Seed three COEXISTING live locks on one path: main (A), feature (B), branchless (C). */
  function seedThreeBranches(): void {
    for (const [sessionId, branch] of [
      [SESSION_A, "main"],
      [SESSION_B, "feature"],
      [SESSION_C, null],
    ] as const) {
      const r = acquireLock(db, {
        repoRoot: REPO_A,
        path,
        sessionId,
        mode: "exclusive",
        timeoutSeconds: 1800,
        branch,
        crossBranchMode: "ignore",
      });
      expect(r.ok).toBe(true);
    }
    expect(rowCount(db, path)).toBe(3);
  }

  it("returns exactly the requested branch's row when branches coexist", () => {
    seedThreeBranches();

    const main = checkLock(db, REPO_A, path, "main");
    expect(main.held).toBe(true);
    if (main.held) {
      expect(main.lock.branch).toBe("main");
      expect(main.lock.session_id).toBe(SESSION_A);
    }

    const feature = checkLock(db, REPO_A, path, "feature");
    expect(feature.held).toBe(true);
    if (feature.held) {
      expect(feature.lock.branch).toBe("feature");
      expect(feature.lock.session_id).toBe(SESSION_B);
    }
  });

  it("explicit null matches ONLY the branchless row (IS, not =)", () => {
    seedThreeBranches();

    const r = checkLock(db, REPO_A, path, null);
    expect(r.held).toBe(true);
    if (r.held) {
      expect(r.lock.branch).toBeNull();
      expect(r.lock.session_id).toBe(SESSION_C);
    }
  });

  it("reports free for a branch with no lock even while other branches hold one", () => {
    // Only a 'feature' lock exists — neither "main" nor branchless may match it.
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
    });

    expect(checkLock(db, REPO_A, path, "main").held).toBe(false);
    expect(checkLock(db, REPO_A, path, null).held).toBe(false);
  });

  it("omitted branch still returns SOME live row (any-branch behaviour pinned)", () => {
    seedThreeBranches();

    const r = checkLock(db, REPO_A, path);
    expect(r.held).toBe(true);
    if (r.held) expect(r.lock.path).toBe(path);
  });

  it("omitted branch skips an EXPIRED row and reports the LIVE sibling (M5.1c)", () => {
    // Expired 'feature' seeded FIRST — before M5.1c the unconstrained .get()
    // picked it by scan order and reported free despite the live 'main' lock.
    seedLock(
      db,
      path,
      SESSION_B,
      "2000-01-01T00:30:00.000Z",
      "2000-01-01T00:00:00.000Z",
      "exclusive",
      REPO_A,
      "feature"
    );
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
      crossBranchMode: "ignore",
    });

    const r = checkLock(db, REPO_A, path);
    expect(r.held).toBe(true);
    if (r.held) expect(r.lock.branch).toBe("main");
  });
});

describe("listLocks", () => {
  it("returns only non-expired locks, ordered by path", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/live-b.ts",
      sessionId: SESSION_B,
      mode: "advisory",
      timeoutSeconds: 1800,
    });
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/live-a.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    seedLock(db, "/repo/dead.ts", SESSION_A, "2000-01-01T00:30:00.000Z");

    const live = listLocks(db, REPO_A);
    expect(live.map((l) => l.path)).toEqual(["/repo/live-a.ts", "/repo/live-b.ts"]);
  });
});

describe("expireStaleLocks", () => {
  it("deletes only expired rows and returns how many were removed", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    seedLock(db, "/repo/dead-1.ts", SESSION_A, "2000-01-01T00:30:00.000Z");
    seedLock(db, "/repo/dead-2.ts", SESSION_B, "2000-01-01T00:30:00.000Z");

    expect(expireStaleLocks(db)).toBe(2);

    const remaining = listLocks(db, REPO_A).map((l) => l.path);
    expect(remaining).toEqual(["/repo/live.ts"]);
    expect(rowCount(db)).toBe(1);
  });

  it("returns 0 when nothing is expired", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
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
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      repoRoot: REPO_A,
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
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      repoRoot: REPO_A,
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
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      repoRoot: REPO_A,
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
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      repoRoot: REPO_A,
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
    // This is the crucial one: UNIQUE(repo_root, path, branch) will NOT stop two
    // (path, NULL) rows because SQL treats NULL != NULL. The block here is
    // enforced by the engine's selectSame check, not by the database constraint.
    const a = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      repoRoot: REPO_A,
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

describe("acquireLock — repo isolation", () => {
  it("same path and branch in different repos do not conflict", () => {
    const a = acquireLock(db, {
      repoRoot: REPO_A,
      path: "src/index.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(a.ok).toBe(true);

    // Same path, same branch, DIFFERENT repo, different session → must succeed.
    const b = acquireLock(db, {
      repoRoot: REPO_B,
      path: "src/index.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(b.ok).toBe(true);

    // Both rows coexist — repo_root genuinely isolates them.
    expect(rowCount(db, "src/index.ts")).toBe(2);

    // checkLock is repo-scoped: each repo sees only its own holder.
    const ca = checkLock(db, REPO_A, "src/index.ts");
    const cb = checkLock(db, REPO_B, "src/index.ts");
    expect(ca.held).toBe(true);
    if (ca.held) expect(ca.lock.session_id).toBe(SESSION_A);
    expect(cb.held).toBe(true);
    if (cb.held) expect(cb.lock.session_id).toBe(SESSION_B);

    // listLocks is repo-scoped: repo A does not see repo B's lock and vice versa.
    expect(listLocks(db, REPO_A).map((l) => l.repo_root)).toEqual([REPO_A]);
    expect(listLocks(db, REPO_B).map((l) => l.repo_root)).toEqual([REPO_B]);
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
          `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          REPO_A,
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
          repoRoot: REPO_A,
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
        repoRoot: REPO_A,
        path,
        sessionId: SESSION_A,
        mode: "exclusive",
        timeoutSeconds: 1800,
      });
      const r2 = acquireLock(connB, {
        repoRoot: REPO_A,
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

describe("forceReleaseLock (M6.2c)", () => {
  const path = "/repo/forced.ts";

  it("deletes ALL sessions' rows on the path across branches, returned branch-ordered", () => {
    // Three claims on one path: two sessions, three branches (incl. branchless).
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
      crossBranchMode: "ignore",
    });
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
      crossBranchMode: "ignore",
    });
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
      crossBranchMode: "ignore",
    });

    const deleted = forceReleaseLock(db, REPO_A, path);

    // No ownership filter: every session's row went. SQLite ASC: NULL first.
    expect(deleted.map((l) => l.branch)).toEqual([null, "feature", "main"]);
    expect(rowCount(db, path)).toBe(0);
  });

  it("leaves other paths and other repos untouched (S1)", () => {
    const samePathOtherRepo = path;
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/bystander.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    acquireLock(db, {
      repoRoot: REPO_B,
      path: samePathOtherRepo,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });

    const deleted = forceReleaseLock(db, REPO_A, path);

    expect(deleted).toHaveLength(1);
    // The bystander path and the same path string in REPO_B both survive.
    expect(rowCount(db, "/repo/bystander.ts")).toBe(1);
    expect(checkLock(db, REPO_B, samePathOtherRepo).held).toBe(true);
  });

  it("returns [] when the path has no locks", () => {
    expect(forceReleaseLock(db, REPO_A, "/repo/nothing-here.ts")).toEqual([]);
  });

  it("returns and deletes EXPIRED rows too (sweeping the path clean)", () => {
    seedLock(db, path, SESSION_A, "2000-01-01T00:30:00.000Z"); // long expired
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
      crossBranchMode: "ignore",
    });

    const deleted = forceReleaseLock(db, REPO_A, path);

    expect(deleted).toHaveLength(2);
    const sessions = deleted.map((l) => l.session_id).sort();
    expect(sessions).toEqual([SESSION_A, SESSION_B]);
    expect(rowCount(db, path)).toBe(0);
  });
});
