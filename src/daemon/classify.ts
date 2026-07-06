import type { MeshLockDatabase } from "../core/db.js";
import { checkLock, type Lock } from "../core/lock-engine.js";
import type { WatchEvent } from "./watcher.js";

/**
 * The daemon's judgment on one filesystem event — a discriminated union on
 * `kind`, same pattern as the engine's AcquireResult. Both variants carry the
 * full WatchEvent through, so M4.3 policy can distinguish e.g. a delete-under-
 * lock from a change-under-lock without reclassifying; "guarded" additionally
 * carries the live lock row (holder, mode, branch, expiry) for the policy to
 * act on.
 *
 * KNOWN LIMITS (documented, not solved here):
 *  - Attribution: a live lock on the path does NOT prove the lock's holder made
 *    this edit. OS file events carry no session identity, so "guarded" means
 *    "someone holds a lock", not "the holder did this". Full attribution is
 *    parked with the M8 identity question.
 *  - Branch: checkLock is path-level within the repo, so "guarded" means the
 *    path is locked on SOME branch — not necessarily the branch the working
 *    tree currently has checked out.
 */
export type Verdict =
  | { kind: "guarded"; event: WatchEvent; lock: Lock }
  | { kind: "unguarded"; event: WatchEvent };

/**
 * Classify one watcher event against the locks table: a LIVE lock on the
 * event's path (in the injected repo) ⇒ guarded; anything else — no lock, or an
 * expired one (checkLock already treats expired as free) ⇒ unguarded, the flag
 * the daemon exists to raise.
 *
 * Pure and synchronous by design: no git calls, no fs reads, no config —
 * `repoRoot` is injected (the daemon resolves it once at startup, M4.3), and
 * the only I/O is the checkLock lookup. All three event types classify by the
 * same rule; what to DO about each is M4.3 policy, not classification.
 */
export function classifyEvent(
  db: MeshLockDatabase,
  repoRoot: string,
  event: WatchEvent
): Verdict {
  const result = checkLock(db, repoRoot, event.path);
  return result.held
    ? { kind: "guarded", event, lock: result.lock }
    : { kind: "unguarded", event };
}
