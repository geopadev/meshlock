import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { getCurrentBranch, clearBranchCache } from "./git.js";

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
