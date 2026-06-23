import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import { getCurrentBranch, getRepoRoot, clearBranchCache } from "./git.js";

let tempDir: string;

/**
 * Build a real git repo in `dir` with one commit, then create and check out
 * `branch`. The commit is required: `rev-parse --abbrev-ref HEAD` cannot resolve
 * an unborn branch, so HEAD must point at a real commit first.
 */
async function makeGitRepo(dir: string, branch: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "MeshLock Test");
  await writeFile(join(dir, "README.md"), "test\n", "utf-8");
  await git.add(["README.md"]);
  await git.commit("initial commit");
  await git.checkoutLocalBranch(branch);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-git-test-"));
  // Module-level cache leaks across cases otherwise.
  clearBranchCache();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("getCurrentBranch", () => {
  it("returns the current branch name for a real git repo", async () => {
    await makeGitRepo(tempDir, "feature-x");
    expect(await getCurrentBranch(tempDir)).toBe("feature-x");
  });

  it("returns null for a directory that is not a git repo (no throw)", async () => {
    expect(await getCurrentBranch(tempDir)).toBeNull();
  });

  it("serves the cached value without re-resolving within the TTL", async () => {
    await makeGitRepo(tempDir, "feature-x");
    expect(await getCurrentBranch(tempDir)).toBe("feature-x"); // populates cache

    // Switch the on-disk branch. Within the TTL the cache should still answer
    // with the old value, proving git was not re-run.
    await simpleGit(tempDir).checkoutLocalBranch("switched");
    expect(await getCurrentBranch(tempDir)).toBe("feature-x");
  });

  it("re-resolves after the cache is cleared", async () => {
    await makeGitRepo(tempDir, "feature-x");
    expect(await getCurrentBranch(tempDir)).toBe("feature-x");
    await simpleGit(tempDir).checkoutLocalBranch("switched");

    clearBranchCache();
    expect(await getCurrentBranch(tempDir)).toBe("switched");
  });
});

describe("getRepoRoot", () => {
  it("returns the repository top-level path inside a git repo", async () => {
    await makeGitRepo(tempDir, "feature-x");
    // git --show-toplevel returns the symlink-resolved path, so normalize both
    // sides with realpath (matters on macOS where /tmp -> /private/tmp).
    expect(await getRepoRoot(tempDir)).toBe(await realpath(tempDir));
  });

  it("returns the directory's own absolute path (sentinel) when not a git repo", async () => {
    const root = await getRepoRoot(tempDir);
    expect(root).toBe(resolve(tempDir));
    expect(root).not.toBe(""); // a real path, never null/empty
  });

  it("caches within the TTL and re-resolves after clearBranchCache", async () => {
    await makeGitRepo(tempDir, "feature-x");
    const sub = join(tempDir, "sub");
    await mkdir(sub);

    // From a subdirectory, the repo root is the repo top-level.
    const repoTop = await realpath(tempDir);
    expect(await getRepoRoot(sub)).toBe(repoTop);

    // Deinit the repo; within the TTL the cache still answers with the old root.
    await rm(join(tempDir, ".git"), { recursive: true, force: true });
    expect(await getRepoRoot(sub)).toBe(repoTop);

    // After clearing, it re-resolves to the sentinel (sub's own absolute path).
    clearBranchCache();
    expect(await getRepoRoot(sub)).toBe(resolve(sub));
  });
});
