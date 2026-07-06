import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { classifyEvent } from "./classify.js";
import type { WatchEvent } from "./watcher.js";

let tempDir: string;
let db: MeshLockDatabase;

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";
const SESSION = "88888888-8888-4888-8888-888888888888";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-classify-test-"));
  db = openDatabase(join(tempDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

/** A normalized watcher event, synthetic — no chokidar involved. */
function event(path: string, type: WatchEvent["type"] = "change"): WatchEvent {
  return { type, path, at: "2026-07-06T12:00:00.000Z" };
}

/** Seed a live lock through the real engine. */
function seedLive(repoRoot: string, path: string, branch: string | null = null): void {
  acquireLock(db, {
    repoRoot,
    path,
    sessionId: SESSION,
    mode: "exclusive",
    timeoutSeconds: 1800,
    branch,
    crossBranchMode: "ignore",
  });
}

/** Seed an already-expired lock directly (acquireLock can't create the past). */
function seedExpired(repoRoot: string, path: string, branch: string | null = null): void {
  db.prepare(
    `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    repoRoot,
    path,
    SESSION,
    "exclusive",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:30:00.000Z",
    branch
  );
}

describe("classifyEvent", () => {
  it("returns guarded with the lock row for a change on a live-locked path", () => {
    const path = "/repos/alpha/src/db.ts";
    seedLive(REPO_A, path);

    const verdict = classifyEvent(db, REPO_A, event(path));

    expect(verdict.kind).toBe("guarded");
    if (verdict.kind === "guarded") {
      expect(verdict.lock.session_id).toBe(SESSION);
      expect(verdict.event.path).toBe(path);
    }
  });

  it("returns unguarded for a change on an unlocked path", () => {
    const verdict = classifyEvent(db, REPO_A, event("/repos/alpha/free.ts"));
    expect(verdict).toEqual({
      kind: "unguarded",
      event: event("/repos/alpha/free.ts"),
    });
  });

  it("returns unguarded when the path's lock is EXPIRED", () => {
    const path = "/repos/alpha/stale.ts";
    seedExpired(REPO_A, path);

    const verdict = classifyEvent(db, REPO_A, event(path));

    // An expired lock guards nothing — checkLock treats it as free.
    expect(verdict.kind).toBe("unguarded");
  });

  it("returns guarded when an EXPIRED lock coexists with a LIVE lock on another branch (M5.1c)", () => {
    const path = "/repos/alpha/mixed.ts";
    // Expired 'feature' seeded FIRST: before M5.1c the any-branch lookup could
    // pick this row, report free, and raise a false UNGUARDED despite the live
    // 'main' lock.
    seedExpired(REPO_A, path, "feature");
    seedLive(REPO_A, path, "main");

    const verdict = classifyEvent(db, REPO_A, event(path));

    expect(verdict.kind).toBe("guarded");
    if (verdict.kind === "guarded") expect(verdict.lock.branch).toBe("main");
  });

  it("returns unguarded when the same path string is locked only in a DIFFERENT repo", () => {
    const path = "src/index.ts";
    seedLive(REPO_B, path); // live lock, wrong repo

    const verdict = classifyEvent(db, REPO_A, event(path));

    // S1 isolation: repo A's daemon must not see repo B's lock as protection.
    expect(verdict.kind).toBe("unguarded");
  });

  it("preserves the event type through a guarded verdict (unlink under lock)", () => {
    const path = "/repos/alpha/deleted.ts";
    seedLive(REPO_A, path);

    const verdict = classifyEvent(db, REPO_A, event(path, "unlink"));

    expect(verdict.kind).toBe("guarded");
    if (verdict.kind === "guarded") {
      // M4.3 policy needs to see it was a DELETE under lock, not a mere change.
      expect(verdict.event.type).toBe("unlink");
      expect(verdict.lock.session_id).toBe(SESSION);
    }
  });
});
