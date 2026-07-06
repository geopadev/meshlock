import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock, type Lock } from "../core/lock-engine.js";
import { clearBranchCache, getRepoRoot } from "../core/git.js";
import { runPreCommit, type PreCommitDeps } from "./run.js";

const MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let dbDir: string;
let db: MeshLockDatabase;
let repoDir: string;
// getRepoRoot's symlink-canonical answer for repoDir — lock paths build on it.
let repoRoot: string;

/** Run a real git command in the temp repo; throw loudly on failure. */
function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

beforeEach(async () => {
  clearBranchCache();
  dbDir = await mkdtemp(join(tmpdir(), "meshlock-hookrun-db-"));
  db = openDatabase(join(dbDir, "test.db"));

  // A REAL repo on branch "main" with one commit, so HEAD (and thus the
  // branch) resolves and deletions have something to be staged against.
  repoDir = await mkdtemp(join(tmpdir(), "meshlock-hookrun-repo-"));
  git(["init", "-q", "-b", "main"], repoDir);
  git(["config", "user.email", "hook@test.local"], repoDir);
  git(["config", "user.name", "Hook Test"], repoDir);
  await writeFile(join(repoDir, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], repoDir);
  git(["commit", "-q", "-m", "seed"], repoDir);

  repoRoot = await getRepoRoot(repoDir);
});

afterEach(async () => {
  db.close();
  await rm(dbDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

/** Write + `git add` a file; return the canonical absolute path locks use. */
async function stage(rel: string, content = "content\n"): Promise<string> {
  await writeFile(join(repoDir, rel), content);
  git(["add", rel], repoDir);
  return join(repoRoot, rel);
}

/** Seed a live lock through the real engine; return the row (for expiry). */
function seedLock(path: string, sessionId: string, branch: string | null): Lock {
  const result = acquireLock(db, {
    repoRoot,
    path,
    sessionId,
    mode: "exclusive",
    timeoutSeconds: 1800,
    branch,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.lock;
}

function deps(): PreCommitDeps {
  return { db, cwd: repoDir, sessionId: MINE };
}

describe("runPreCommit", () => {
  it("exits 0 with no message on an empty stage", async () => {
    // Nothing staged after the seed commit.
    expect(await runPreCommit(deps())).toEqual({ exitCode: 0, message: null });
  });

  it("exits 0 with no message when staged files carry no locks", async () => {
    await stage("clean.ts");
    expect(await runPreCommit(deps())).toEqual({ exitCode: 0, message: null });
  });

  it("exits 1 naming path, holder, branch, and expiry on a foreign same-branch live lock", async () => {
    const abs = await stage("guarded.ts");
    const lock = seedLock(abs, OTHER, "main");

    const result = await runPreCommit(deps());

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("guarded.ts");
    expect(result.message).toContain(OTHER.slice(0, 8));
    expect(result.message).toContain("main");
    expect(result.message).toContain(lock.expires_at);
  });

  it("exits 0 over the session's OWN live lock", async () => {
    const abs = await stage("mine.ts");
    seedLock(abs, MINE, "main");

    expect(await runPreCommit(deps())).toEqual({ exitCode: 0, message: null });
  });

  it("lists EVERY conflict, not just the first", async () => {
    const a = await stage("a.ts");
    const b = await stage("b.ts");
    await stage("free.ts");
    seedLock(a, OTHER, "main");
    seedLock(b, OTHER, "main");

    const result = await runPreCommit(deps());

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("a.ts");
    expect(result.message).toContain("b.ts");
    expect(result.message).not.toContain("free.ts");
  });

  it("parses a filename containing a space via NUL splitting", async () => {
    const abs = await stage("has space.ts");
    seedLock(abs, OTHER, "main");

    const result = await runPreCommit(deps());

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("has space.ts");
  });

  it("gates a staged DELETION via the plain-join fallback (file is gone)", async () => {
    // seed.txt is committed and on disk; lock it as a foreign claim, then
    // stage its deletion — realpath ENOENTs, the join fallback must still
    // find the lock row.
    seedLock(join(repoRoot, "seed.txt"), OTHER, "main");
    git(["rm", "-q", "seed.txt"], repoDir);

    const result = await runPreCommit(deps());

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("seed.txt");
  });

  it("FAIL-OPEN: a broken DB exits 0 with a warning, never blocking the commit", async () => {
    await stage("anything.ts");
    const broken = openDatabase(join(dbDir, "broken.db"));
    broken.close(); // every statement on it now throws

    const result = await runPreCommit({ db: broken, cwd: repoDir, sessionId: MINE });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("fail-open");
  });
});
