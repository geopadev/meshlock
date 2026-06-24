import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { simpleGit } from "simple-git";

/**
 * How long a resolved git fact (branch or repo root) stays cached per working
 * directory. Short enough that a `git checkout` is picked up quickly, long
 * enough that a burst of tool calls spawns at most one `git` subprocess per
 * window.
 */
export const BRANCH_CACHE_TTL_MS = 5000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Keyed by working directory — different cwds can be different repositories, so
// they must not share a cached value. Branch and repo root are cached
// separately: they answer different questions and have different value types
// (branch may be null; repo root is always a string). Module-level, so they
// survive across calls; tests reset both with clearBranchCache().
const branchCache = new Map<string, CacheEntry<string | null>>();
const repoRootCache = new Map<string, CacheEntry<string>>();

/** Drop all cached git resolutions (branch and repo root). Mainly for tests. */
export function clearBranchCache(): void {
  branchCache.clear();
  repoRootCache.clear();
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
  const cached = branchCache.get(cwd);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const value = await resolveBranch(cwd);
  branchCache.set(cwd, { value, expiresAt: Date.now() + BRANCH_CACHE_TTL_MS });
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

/**
 * Resolve the git repository root that `cwd` belongs to (defaults to the
 * process's working directory; callers scoping a file pass that file's
 * directory, since repo membership is a property of where the file lives).
 *
 * Unlike {@link getCurrentBranch}, this returns a non-null SENTINEL: when `cwd`
 * is not inside a git repo (or any git error), it returns `cwd`'s own path,
 * realpath-normalized so it matches git's symlink-resolved --show-toplevel (e.g.
 * macOS /tmp -> /private/tmp). A non-git file's "repo root" is just its own
 * directory. This keeps repo_root out of the NULL-uniqueness trap — it is always
 * a real string, so a UNIQUE(repo_root, ...) constraint behaves normally. NEVER
 * throws.
 *
 * Cached per cwd for {@link BRANCH_CACHE_TTL_MS}, like branch resolution.
 */
export async function getRepoRoot(cwd: string = process.cwd()): Promise<string> {
  const cached = repoRootCache.get(cwd);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const value = await resolveRepoRoot(cwd);
  repoRootCache.set(cwd, { value, expiresAt: Date.now() + BRANCH_CACHE_TTL_MS });
  return value;
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const root = (
      await simpleGit(cwd).revparse(["--show-toplevel"])
    ).trim();
    if (root !== "") return root;
  } catch {
    // Not a git repo (or git unavailable): fall through to the sentinel.
  }
  // Sentinel: the directory's own path, realpath-normalized to match git's
  // symlink-resolved output. realpath throws if the path doesn't exist, so fall
  // back to resolve() to keep the never-throws contract.
  try {
    return await realpath(cwd);
  } catch {
    return resolve(cwd);
  }
}
