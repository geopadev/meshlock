import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { checkCommit } from "./pre-commit.js";

let tempDir: string;
let db: MeshLockDatabase;

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";
const MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-precommit-test-"));
  db = openDatabase(join(tempDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

/** Seed a live lock through the real engine. */
function seedLive(
  repoRoot: string,
  path: string,
  sessionId: string,
  branch: string | null
): void {
  acquireLock(db, {
    repoRoot,
    path,
    sessionId,
    mode: "exclusive",
    timeoutSeconds: 1800,
    branch,
  });
}

/** Seed an already-expired lock directly (acquireLock can't create the past). */
function seedExpired(
  repoRoot: string,
  path: string,
  sessionId: string,
  branch: string | null
): void {
  db.prepare(
    `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    repoRoot,
    path,
    sessionId,
    "exclusive",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:30:00.000Z",
    branch
  );
}

/** Base input on repo A, branch main, as MINE — tests override what they probe. */
function input(stagedPaths: string[], branch: string | null = "main") {
  return { repoRoot: REPO_A, branch, sessionId: MINE, stagedPaths };
}

describe("checkCommit", () => {
  it("blocks when another session holds a live same-branch lock, reporting path+lock", () => {
    const path = "/repos/alpha/src/db.ts";
    seedLive(REPO_A, path, OTHER, "main");

    const verdict = checkCommit(db, input([path]));

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.conflicts).toHaveLength(1);
      expect(verdict.conflicts[0]!.path).toBe(path);
      expect(verdict.conflicts[0]!.lock.session_id).toBe(OTHER);
    }
  });

  it("allows committing over your OWN live lock", () => {
    const path = "/repos/alpha/src/mine.ts";
    seedLive(REPO_A, path, MINE, "main");

    expect(checkCommit(db, input([path]))).toEqual({ allowed: true });
  });

  it("allows when the live lock is on a DIFFERENT branch (cross-branch never blocks)", () => {
    const path = "/repos/alpha/src/crossed.ts";
    seedLive(REPO_A, path, OTHER, "feature");

    expect(checkCommit(db, input([path], "main"))).toEqual({ allowed: true });
  });

  it("blocks a branchless committer on a branchless foreign lock (null matches null)", () => {
    const path = "/repos/alpha/src/branchless.ts";
    seedLive(REPO_A, path, OTHER, null);

    const verdict = checkCommit(db, input([path], null));

    expect(verdict.allowed).toBe(false);
  });

  it("allows when the foreign same-branch lock is EXPIRED", () => {
    const path = "/repos/alpha/src/stale.ts";
    seedExpired(REPO_A, path, OTHER, "main");

    expect(checkCommit(db, input([path]))).toEqual({ allowed: true });
  });

  it("allows when the same path string is locked only in a DIFFERENT repo (S1 isolation)", () => {
    const path = "src/index.ts";
    seedLive(REPO_B, path, OTHER, "main");

    expect(checkCommit(db, input([path]))).toEqual({ allowed: true });
  });

  it("reports ALL conflicts across multiple staged paths, not just the first", () => {
    const conflictA = "/repos/alpha/src/a.ts";
    const conflictB = "/repos/alpha/src/b.ts";
    const free = "/repos/alpha/src/free.ts";
    seedLive(REPO_A, conflictA, OTHER, "main");
    seedLive(REPO_A, conflictB, OTHER, "main");

    const verdict = checkCommit(db, input([conflictA, free, conflictB]));

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.conflicts.map((c) => c.path)).toEqual([conflictA, conflictB]);
    }
  });

  it("allows an empty staged set", () => {
    expect(checkCommit(db, input([]))).toEqual({ allowed: true });
  });
});
