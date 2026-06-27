import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../../core/db.js";
import { acquireLock, type CrossBranchMode } from "../../core/lock-engine.js";
import type { Config } from "../../core/config.js";
import { clearBranchCache, getRepoRoot } from "../../core/git.js";
import { makeAcquireLockHandler } from "./acquire-lock.js";

// The tool now resolves the branch from process.cwd(). We chdir into a non-git
// temp dir for each test so that resolution falls back to null deterministically
// (vitest itself runs inside the meshlock git repo). Restored in afterEach.
const ORIGINAL_CWD = process.cwd();

let tempDir: string;
let db: MeshLockDatabase;
// The repo_root the handler resolves from each path's dir (cwd === tempDir here).
// Seeds use the same value so they land in the repo the handler queries.
let repoRoot: string;

// The session the tool acts as (from config) and a different session we seed
// conflicting locks under.
const CONFIG_SESSION = "44444444-4444-4444-8444-444444444444";
const OTHER_SESSION = "55555555-5555-4555-8555-555555555555";

function makeConfig(crossBranchMode: CrossBranchMode = "warn"): Config {
  return {
    mode: "solo",
    session_id: CONFIG_SESSION,
    relay_url: null,
    lock_timeout: 1800,
    lock_mode: "exclusive",
    granularity: "file",
    cross_branch_mode: crossBranchMode,
  };
}

/** Pull the plain text out of a CallToolResult for assertions. */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) {
    throw new Error("expected a text content block");
  }
  return block.text;
}

function rowCount(path: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM locks WHERE path = ?").get(path) as {
      n: number;
    }
  ).n;
}

function branchOf(path: string): string | null {
  return (
    db.prepare("SELECT branch FROM locks WHERE path = ?").get(path) as {
      branch: string | null;
    }
  ).branch;
}

function snapshotOf(path: string): string | null {
  return (
    db.prepare("SELECT content_snapshot FROM locks WHERE path = ?").get(path) as {
      content_snapshot: string | null;
    }
  ).content_snapshot;
}

beforeEach(async () => {
  // A temp dir under the OS tmp root: it exists but is NOT a git repo. We chdir
  // into it so the tool's branch resolution (process.cwd()) falls back to null.
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-acquire-test-"));
  db = openDatabase(join(tempDir, "test.db"));
  process.chdir(tempDir);
  clearBranchCache();
  repoRoot = await getRepoRoot(tempDir);
});

afterEach(async () => {
  // Restore cwd before removing the temp dir we were sitting in.
  process.chdir(ORIGINAL_CWD);
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("acquire_lock handler", () => {
  it("acquires a free path and writes the lock row", async () => {
    const path = join(tempDir, "free.ts");
    const handler = makeAcquireLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(text).toContain("no branch");
    expect(rowCount(path)).toBe(1);
  });

  it("falls back to a branchless lock when there is no git repo (does not throw)", async () => {
    // cwd is the non-git temp dir, so branch resolution returns null —
    // proving git is not a hard requirement.
    const path = join(tempDir, "nogit.ts");
    const handler = makeAcquireLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(branchOf(path)).toBeNull();
  });

  it("reports a held conflict instead of throwing", async () => {
    const path = join(tempDir, "taken.ts");
    // Another session already holds this branchless lock.
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });

    const handler = makeAcquireLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("LOCKED");
    expect(text).toContain(OTHER_SESSION);
    expect(rowCount(path)).toBe(1);
  });

  it("config cross_branch_mode 'block' reaches the engine and blocks a cross-branch acquire", async () => {
    const path = join(tempDir, "cross.ts");
    // A lock on another branch held by another session.
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    // Tool resolves branch=null here; with config "block" the engine must block.
    const handler = makeAcquireLockHandler(db, makeConfig("block"));
    const text = firstText(await handler({ path }));

    expect(text).toContain("LOCKED");
    expect(text).toContain(OTHER_SESSION);
    // Only the seeded "main" row exists; the null-branch acquire was refused.
    expect(rowCount(path)).toBe(1);
  });

  it("config cross_branch_mode 'warn' reaches the engine and acquires with a warning", async () => {
    const path = join(tempDir, "cross.ts");
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const handler = makeAcquireLockHandler(db, makeConfig("warn"));
    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(text).toContain("WARNING");
    expect(text).toContain("main");
    expect(text).toContain(OTHER_SESSION);
    // Both locks now coexist: the seeded "main" plus our branchless one.
    expect(rowCount(path)).toBe(2);
  });

  it("captures the file's content as the snapshot when the file exists", async () => {
    const path = join(tempDir, "withcontent.ts");
    await writeFile(path, "export const answer = 42;\n");
    const handler = makeAcquireLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(snapshotOf(path)).toBe("export const answer = 42;\n");
  });

  it("captures a null snapshot for a non-existent path and does not throw", async () => {
    // The file is never created — reading it ENOENTs, which the tool swallows.
    const path = join(tempDir, "ghost.ts");
    const handler = makeAcquireLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(snapshotOf(path)).toBeNull();
  });
});
