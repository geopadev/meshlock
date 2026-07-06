import type { MeshLockDatabase } from "../core/db.js";
import { checkLock, type Lock } from "../core/lock-engine.js";

/** One staged path that a live foreign lock refuses to let past. */
export interface CommitConflict {
  path: string;
  /** The blocking lock row — holder, branch, expiry — for the error message. */
  lock: Lock;
}

/**
 * The gate's answer — a discriminated union on `allowed`, same pattern as the
 * engine's AcquireResult and the daemon's Verdict. The blocked variant carries
 * EVERY conflict, not just the first: the committer should fix the complete
 * list off one failed commit, not discover them one fail-fix-fail at a time.
 */
export type HookVerdict =
  | { allowed: true }
  | { allowed: false; conflicts: CommitConflict[] };

/** Input to {@link checkCommit}. Everything resolved by the caller (M5.2). */
export interface CommitCheckInput {
  repoRoot: string;
  /** The committer's current branch; null = branchless (not a git branch head). */
  branch: string | null;
  /** This machine's session — its OWN locks never block its commits. */
  sessionId: string;
  /** ABSOLUTE staged paths — the M5.2 shim converts from repo-relative. */
  stagedPaths: string[];
}

/**
 * Decide whether a commit may proceed: block iff some staged path carries a
 * LIVE lock held by ANOTHER session on the SAME branch.
 *
 * The rules MIRROR the engine rather than re-invent it:
 *  - Liveness and expiry are checkLock's business — an expired lock reports
 *    as free and never blocks.
 *  - Own-session locks never block (`session_id === sessionId` is the
 *    committer's own declared claim).
 *  - Same-branch is enforced IN the lookup (M5.1b): the committer's branch is
 *    passed to checkLock, whose `branch IS ?` filter null-safely matches a
 *    branchless lock to a branchless committer — no re-comparison here.
 *  - A live lock on a DIFFERENT branch does not block, consistent with M2.5's
 *    cross-branch warn-not-block decision — the filter simply never returns it.
 *
 * The attribution limit (daemon/classify.ts) does NOT apply here: we are not
 * guessing who made an edit — we are refusing to commit over someone's
 * declared live claim. The BRANCH limit is RESOLVED for this consumer (M5.1b):
 * with coexisting per-branch locks on one path, the branch-filtered checkLock
 * deterministically returns the committer's-branch row (or none) instead of an
 * arbitrary branch's row.
 *
 * Pure and synchronous: no git, no fs, no config — branch and sessionId are
 * injected by the caller (M5.2), and the only I/O is checkLock per staged path.
 */
export function checkCommit(
  db: MeshLockDatabase,
  input: CommitCheckInput
): HookVerdict {
  const conflicts: CommitConflict[] = [];

  for (const path of input.stagedPaths) {
    // input.branch is string|null, never undefined → the lookup ALWAYS
    // branch-filters; cross-branch locks are excluded before we ever see them.
    const result = checkLock(db, input.repoRoot, path, input.branch);
    if (!result.held) continue; // free, or expired (checkLock's liveness)
    if (result.lock.session_id === input.sessionId) continue; // own claim
    conflicts.push({ path, lock: result.lock });
  }

  return conflicts.length > 0 ? { allowed: false, conflicts } : { allowed: true };
}
