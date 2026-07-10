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
 * Strategy, never throws (the getRepoRoot sentinel spirit):
 *  1. Path exists → realpathSync(path): the OS's own canonical answer.
 *  2. Path missing (locking a file about to be CREATED is legitimate — M3.5b,
 *     and the missing suffix may be several levels deep, e.g. a new directory
 *     plus a new file) → WALK UP via dirname() to the deepest EXISTING
 *     ancestor, canonicalize that, and re-join the missing remainder. The
 *     symlinked-prefix variance lives in the existing directories, so this
 *     fixes the alias problem however deep the not-yet-created suffix is.
 *     Terminates because dirname() strictly shortens toward the fs root,
 *     which always realpaths.
 *  3. If even the walk finds no realpath-able ancestor (pathological — e.g.
 *     realpath failing for non-ENOENT reasons all the way up) → resolve(path):
 *     plain lexical absolutization keeps the never-throws contract.
 */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    let ancestor = dirname(path);
    let remainder = basename(path);
    for (;;) {
      try {
        return join(realpathSync(ancestor), remainder);
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          // Reached the fs root without one successful realpath.
          return resolve(path);
        }
        remainder = join(basename(ancestor), remainder);
        ancestor = parent;
      }
    }
  }
}
