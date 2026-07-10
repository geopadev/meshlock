import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import type { MeshLockDatabase } from "../core/db.js";
import { getCurrentBranch, getRepoRoot } from "../core/git.js";
import { canonicalizePath } from "../core/paths.js";
import { checkCommit, type CommitConflict } from "./pre-commit.js";

/**
 * Everything runPreCommit needs, injected — db handle, working directory, and
 * this machine's session identity. The CLI assembles these from config; tests
 * pass temp equivalents and drive the runtime directly, no process spawning.
 */
export interface PreCommitDeps {
  db: MeshLockDatabase;
  /** Where git commands run — any directory inside the committing repo. */
  cwd: string;
  /** This machine's session — its own locks never block its commits. */
  sessionId: string;
}

/**
 * What the shim should do: `exitCode` becomes the hook process's exit status
 * (git aborts the commit on non-zero); `message` (if any) goes to STDERR —
 * either the conflict listing (exit 1) or a fail-open warning (exit 0).
 */
export interface PreCommitRunResult {
  exitCode: 0 | 1;
  message: string | null;
}

/**
 * List the staged paths, repo-relative, via `git diff --cached --name-only -z`.
 *
 * Parse on NUL, NEVER on newlines: a filename may itself contain a newline
 * (and in line mode git would quote such names, breaking naive parsing). NUL
 * is the one byte a path cannot contain, which is exactly why -z uses it.
 * spawnSync mirrors diff.ts; any git failure throws and is caught by the
 * fail-open wrapper in {@link runPreCommit}.
 */
function listStagedPaths(cwd: string): string[] {
  const result = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
    cwd,
    encoding: "utf-8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `git diff --cached exited with status ${String(result.status)}: ${result.stderr}`
    );
  }
  return result.stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * THE SEAM (M5.1 issue #3): convert one staged repo-relative path to the
 * absolute, symlink-canonical form locks are stored and checked under. Since
 * M6.1 the tools canonicalize with the SAME helper at their boundary, so both
 * sides of the comparison are canonical by construction — the M5.2 residual
 * risk (a lock stored under a non-canonical alias evading this gate) is
 * closed. A staged DELETION is subsumed by the helper's walk-up: the file is
 * gone but its parent exists, so the canonical parent + basename is exactly
 * the string the lock row carries.
 */
function toLockPath(repoRoot: string, staged: string): string {
  return canonicalizePath(join(repoRoot, staged));
}

/** One line per conflict — path, holder (first 8 chars), branch, expiry. */
function formatConflicts(repoRoot: string, conflicts: CommitConflict[]): string {
  const lines = conflicts.map(({ path, lock }) => {
    const rel = relative(repoRoot, path) || path;
    const holder = lock.session_id.slice(0, 8);
    const branch = lock.branch ?? "no branch";
    return `  ${rel} — held by session ${holder} (${branch}), expires ${lock.expires_at}`;
  });
  return [
    `[meshlock] commit blocked: ${String(conflicts.length)} staged path(s) carry a live lock held by another session on this branch:`,
    ...lines,
    "Wait for the lock(s) to be released or to expire, or coordinate with the holder.",
  ].join("\n");
}

/**
 * The pre-commit gate runtime: staged paths → canonical lock paths → branch →
 * checkCommit. Exit 1 (blocking the commit) iff checkCommit returns a positive
 * conflict verdict, with a message listing EVERY conflict so the committer
 * fixes the complete list off one failed commit.
 *
 * FAIL-OPEN (decided): ANY internal error — DB unopenable, git failure,
 * unexpected throw — exits 0 with a one-line warning instead of blocking.
 * Exit 1 is reserved for a positive verdict: an enforcement layer that bricks
 * commits when ITSELF broken gets uninstalled, and an uninstalled gate
 * protects nobody. The warning keeps the failure visible without making it
 * fatal.
 */
export async function runPreCommit(deps: PreCommitDeps): Promise<PreCommitRunResult> {
  try {
    const staged = listStagedPaths(deps.cwd);
    if (staged.length === 0) {
      return { exitCode: 0, message: null };
    }

    const repoRoot = await getRepoRoot(deps.cwd);
    const branch = await getCurrentBranch(deps.cwd);
    const stagedPaths = staged.map((rel) => toLockPath(repoRoot, rel));

    const verdict = checkCommit(deps.db, {
      repoRoot,
      branch,
      sessionId: deps.sessionId,
      stagedPaths,
    });

    if (verdict.allowed) {
      return { exitCode: 0, message: null };
    }
    return { exitCode: 1, message: formatConflicts(repoRoot, verdict.conflicts) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 0,
      message: `[meshlock] pre-commit check skipped (fail-open): ${detail}`,
    };
  }
}
