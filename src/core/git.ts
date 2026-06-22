import { simpleGit } from "simple-git";

/**
 * How long a resolved branch stays cached per working directory. Short enough
 * that a `git checkout` is picked up quickly, long enough that a burst of tool
 * calls spawns at most one `git` subprocess per window.
 */
export const BRANCH_CACHE_TTL_MS = 5000;

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

// Keyed by working directory — different cwds can be different repositories, so
// they must not share a cached branch. Module-level, so it survives across
// calls; tests reset it with clearBranchCache().
const cache = new Map<string, CacheEntry>();

/** Drop all cached branch resolutions. Mainly for tests. */
export function clearBranchCache(): void {
  cache.clear();
}

/**
 * Resolve the current git branch of the repository containing `cwd` (defaults to
 * the process's working directory — for the daemon, the repo it coordinates).
 *
 * A branch is a property of the whole repository (one HEAD), so we resolve from
 * the repo's working directory, not from any individual file's directory.
 *
 * Returns null when there is no usable branch — not a git repo, detached HEAD,
 * empty output, or any git failure. NEVER throws: git is not a hard requirement,
 * and null is the engine's "branchless" case.
 *
 * Results are cached per cwd for {@link BRANCH_CACHE_TTL_MS} so repeated tool
 * calls don't each spawn a `git` subprocess.
 */
export async function getCurrentBranch(
  cwd: string = process.cwd()
): Promise<string | null> {
  const cached = cache.get(cwd);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const value = await resolveBranch(cwd);
  cache.set(cwd, { value, expiresAt: Date.now() + BRANCH_CACHE_TTL_MS });
  return value;
}

async function resolveBranch(cwd: string): Promise<string | null> {
  try {
    const branch = (
      await simpleGit(cwd).revparse(["--abbrev-ref", "HEAD"])
    ).trim();
    // "HEAD" means detached; empty means no branch. Both are branchless.
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}
