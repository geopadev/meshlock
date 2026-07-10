import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Symlink-canonical absolute form of an agent-supplied path.
 *
 * WHY entry-point normalization: lock identity is the stored path STRING, and
 * comparisons happen all over — the engine's lookups, the pre-commit hook, the
 * daemon's classify, the change-briefing queries. Canonicalizing one side of
 * any of those comparisons is unsound (a lock acquired via /tmp/alias/f.ts is
 * invisible to a hook checking /tmp/real/f.ts — the M5.2 under-enforcement
 * hole). Normalizing ONCE, where a path ENTERS MeshLock, means every consumer
 * downstream inherits correctness without knowing symlinks exist.
 *
 * Three tiers, never throws (the getRepoRoot sentinel spirit):
 *  1. Path exists → realpathSync(path): the OS's own canonical answer.
 *  2. Path missing (locking a file about to be CREATED is legitimate — M3.5b)
 *     → canonicalize the PARENT and re-join the basename: the symlinked-prefix
 *     variance is in the directories, so this fixes the alias problem even
 *     before the file exists.
 *  3. Parent also missing → resolve(path): plain lexical absolutization, the
 *     best available answer for a path with no fs reality yet.
 */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}
