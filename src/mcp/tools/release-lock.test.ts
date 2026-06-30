import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../../core/db.js";
import { acquireLock } from "../../core/lock-engine.js";
import { getChanges } from "../../core/changes.js";
import type { Config } from "../../core/config.js";
import { getRepoRoot } from "../../core/git.js";
import { makeReleaseLockHandler } from "./release-lock.js";

let tempDir: string;
let db: MeshLockDatabase;
// The repo_root the handler resolves from each path's dir (== tempDir here).
let repoRoot: string;

// The session the tool acts as (from config) and a different session we seed
// other-owner locks under.
const CONFIG_SESSION = "66666666-6666-4666-8666-666666666666";
const OTHER_SESSION = "77777777-7777-4777-8777-777777777777";

function makeConfig(): Config {
  return {
    mode: "solo",
    session_id: CONFIG_SESSION,
    relay_url: null,
    lock_timeout: 1800,
    lock_mode: "exclusive",
    granularity: "file",
    cross_branch_mode: "warn",
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-release-test-"));
  db = openDatabase(join(tempDir, "test.db"));
  repoRoot = await getRepoRoot(tempDir);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("release_lock handler", () => {
  it("releases a lock the calling session owns", async () => {
    const path = join(tempDir, "mine.ts");
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: CONFIG_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Released");
    expect(rowCount(path)).toBe(0);
  });

  it("is a no-op on a lock owned by another session", async () => {
    const path = join(tempDir, "theirs.ts");
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Nothing to release");
    // The other session's lock is untouched.
    expect(rowCount(path)).toBe(1);
  });

  it("is a clean no-op on a path with no lock at all", async () => {
    const path = join(tempDir, "never-locked.ts");
    const handler = makeReleaseLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Nothing to release");
  });

  it("releases all of the session's locks on a path across branches", async () => {
    const path = join(tempDir, "multi.ts");
    // Same session holds the same path on two different branches.
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: CONFIG_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: CONFIG_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
    });
    expect(rowCount(path)).toBe(2);

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    // Branch-agnostic: a single release drops both branch locks.
    expect(text).toContain("Released");
    expect(rowCount(path)).toBe(0);
  });
});

describe("release_lock handler — change recording (M3.5c)", () => {
  /** Acquire with a baseline snapshot, simulating M3.5b's acquire-time capture. */
  function acquireWithSnapshot(path: string, snapshot: string): void {
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: CONFIG_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
      contentSnapshot: snapshot,
    });
  }

  it("records a diff when the file changed between acquire and release", async () => {
    const path = join(tempDir, "edited.ts");
    await writeFile(path, "old content\n");
    acquireWithSnapshot(path, "old content\n");
    // The "edit" the holder made while owning the lock.
    await writeFile(path, "new content\n");

    const handler = makeReleaseLockHandler(db, makeConfig());
    await handler({ path });

    const changes = getChanges(db, { repoRoot, path });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.diff).toContain("-old content");
    expect(changes[0]!.diff).toContain("+new content");
  });

  it("records an empty diff (the floor) when content is unchanged", async () => {
    const path = join(tempDir, "untouched.ts");
    await writeFile(path, "same\n");
    acquireWithSnapshot(path, "same\n");

    const handler = makeReleaseLockHandler(db, makeConfig());
    await handler({ path });

    const changes = getChanges(db, { repoRoot, path });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.diff).toBe("");
  });

  it("passes an optional summary through to the change record", async () => {
    const path = join(tempDir, "summarised.ts");
    await writeFile(path, "before\n");
    acquireWithSnapshot(path, "before\n");
    await writeFile(path, "after\n");

    const handler = makeReleaseLockHandler(db, makeConfig());
    await handler({ path, summary: "rewrote the greeting" });

    const changes = getChanges(db, { repoRoot, path });
    expect(changes[0]!.summary).toBe("rewrote the greeting");
  });

  it("skips recording (no row, no throw) when the file is binary", async () => {
    const path = join(tempDir, "asset.bin");
    await writeFile(path, "before\n");
    acquireWithSnapshot(path, "before\n");
    // The current content is now binary — a NUL byte makes a utf-8 diff garbage.
    await writeFile(path, Buffer.from([0x00, 0x01, 0x02, 0x00]));

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Released");
    expect(getChanges(db, { repoRoot, path })).toHaveLength(0);
  });

  it("does not record when releasing a lock owned by another session", async () => {
    const path = join(tempDir, "not-mine.ts");
    await writeFile(path, "content\n");
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
      contentSnapshot: "content\n",
    });

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Nothing to release");
    expect(getChanges(db, { repoRoot, path })).toHaveLength(0);
  });
});
