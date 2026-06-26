import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Produce a unified diff between two in-memory strings, in git's own format.
 *
 * Why shell out to `git diff --no-index` rather than diff in JS:
 *  - the output is byte-for-byte the format every agent already recognises
 *    (the same thing `git diff` prints), so a briefing reads naturally;
 *  - `--no-index` makes git diff two arbitrary paths with no repository at all,
 *    so this works on content that never touched a repo.
 *
 * git has no "diff two strings" mode — `--no-index` takes two PATHS — so we
 * write the two sides to a scratch temp dir, diff the files, then delete it.
 * The function is synchronous (matching its callers in the lock engine, which
 * is itself synchronous), so every fs/spawn call here is the *Sync variant.
 *
 * EXIT-CODE CONVENTION — the one genuinely surprising thing here:
 * `git diff` exits 0 when the inputs are IDENTICAL and 1 when they DIFFER.
 * For us, "they differ" is the normal, successful case, not an error — so we
 * must NOT treat exit 1 as a failure. We use spawnSync (not execFileSync, which
 * throws on any non-zero exit) precisely so we can inspect the status ourselves:
 *   - status 0  -> identical            -> return "" (no change)
 *   - status 1  -> differences found    -> return the diff on stdout
 *   - anything else (>1, or a spawn error like git-not-found) -> a real fault,
 *     so we throw. A normal diff never throws.
 */
export function diffContent(before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), "meshlock-diff-"));
  try {
    const beforePath = join(dir, "before");
    const afterPath = join(dir, "after");
    writeFileSync(beforePath, before);
    writeFileSync(afterPath, after);

    const result = spawnSync(
      "git",
      ["diff", "--no-index", beforePath, afterPath],
      { encoding: "utf-8" }
    );

    // A spawn-level error (e.g. git is not installed) is a real fault.
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      return "";
    }
    if (result.status === 1) {
      return result.stdout;
    }
    // status > 1, or null (killed by signal): something actually went wrong.
    throw new Error(
      `git diff --no-index exited with status ${String(result.status)}: ${result.stderr}`
    );
  } finally {
    // Always remove the scratch dir, even if git threw.
    rmSync(dir, { recursive: true, force: true });
  }
}
