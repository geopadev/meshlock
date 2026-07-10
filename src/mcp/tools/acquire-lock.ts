import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import type { Config } from "../../core/config.js";
import { acquireLock } from "../../core/lock-engine.js";
import { getCurrentBranch, getRepoRoot } from "../../core/git.js";
import { getChanges, type ChangeRecord } from "../../core/changes.js";
import { canonicalizePath } from "../../core/paths.js";

/**
 * Read the file at `path` as the acquire-time baseline snapshot (M3.5b). This is
 * the TOOL's job, not the engine's: the engine never touches the filesystem, so
 * the tool reads here — OUTSIDE the engine transaction — and injects the content.
 * A missing or unreadable file is NOT an error: there is simply no baseline yet
 * (e.g. the agent is about to CREATE the file), so we capture null and let M3.5c
 * treat a null baseline as "new file" (all content reported as additions).
 */
function captureSnapshot(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * A compact one-line hint from a recorded diff, for the acquire briefing. Prefers
 * the first genuinely-changed line (a +/- line that is not the +++/--- header);
 * an empty diff (a recorded no-op) reads as "(no content change)".
 */
function diffPreview(diff: string): string {
  if (diff === "") return "(no content change)";
  const changed = diff
    .split("\n")
    .find(
      (l) =>
        (l.startsWith("+") || l.startsWith("-")) &&
        !l.startsWith("+++") &&
        !l.startsWith("---")
    );
  const preview = (changed ?? diff.split("\n")[0] ?? "").trim();
  return preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
}

/**
 * One briefing line for a recorded change. Headline prefers diff_stat, then the
 * agent-written summary, then a diff preview — diff_stat/summary are enrichment
 * and may be absent, so the diff (the floor) is the guaranteed fallback.
 */
function formatChange(c: ChangeRecord): string {
  const who = `${c.sessionId.slice(0, 8)}…`;
  const headline = c.diffStat ?? c.summary ?? diffPreview(c.diff);
  return `- ${c.changedAt} by ${who}: ${headline}`;
}

/**
 * Input shape for `acquire_lock`. Only `path` — the tool resolves the git branch
 * itself, so the agent never supplies it.
 */
export const acquireLockInputSchema = {
  path: z
    .string()
    .describe("The file or directory path to lock, e.g. /repo/src/index.ts"),
};

/** Tool name and description, surfaced to the agent in the tools list. */
export const acquireLockToolConfig = {
  description:
    "Acquire a lock on a file path before editing it, so other agents don't edit it at the same time.",
  inputSchema: acquireLockInputSchema,
} as const;

/**
 * Build the `acquire_lock` handler bound to a database and the loaded config.
 * Config supplies session_id / lock_mode / lock_timeout / cross_branch_mode so
 * the handler never re-reads config per call. The handler is async because
 * resolving the branch is async — but that git I/O happens BEFORE the
 * synchronous engine call, never inside its transaction.
 *
 * Both repo_root AND branch resolve from the FILE's directory (dirname(path)):
 * repo membership and the branch of that repo both depend on where the file
 * lives. Resolving the branch from the file's own repo — not the daemon's cwd —
 * keeps the lock coherent even when the file is in a different repo than the
 * daemon is running in (the S1c-issue-#1 fix).
 *
 * NOTE: M3.2c moved this from dirname(path) to cwd; S1c moves it back. Not a
 * flip-flop — getCurrentBranch(dirname(path)) still resolves the whole repo's
 * HEAD (git walks up), and once `meshlock init` made the daemon user-global,
 * cwd points at the DAEMON's repo, not the file's. See the M3.3b learning-log
 * "reconciling with M3.2c" note.
 */
export function makeAcquireLockHandler(db: MeshLockDatabase, config: Config) {
  return async ({ path: rawPath }: { path: string }): Promise<CallToolResult> => {
    // Canonicalize at the boundary (M6.1): everything downstream — branch and
    // repo resolution, the engine lookup, the briefing query — sees the
    // symlink-free form, so an aliased path can't evade the hook or the daemon.
    const path = canonicalizePath(rawPath);
    const branch = await getCurrentBranch(dirname(path));
    const repoRoot = await getRepoRoot(dirname(path));
    // Capture the baseline now, before the engine call. The engine ignores this
    // on a same-session refresh and keeps the original baseline.
    const contentSnapshot = captureSnapshot(path);

    const result = acquireLock(db, {
      repoRoot,
      path,
      sessionId: config.session_id,
      mode: config.lock_mode,
      timeoutSeconds: config.lock_timeout,
      branch,
      crossBranchMode: config.cross_branch_mode,
      contentSnapshot,
    });

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Could not acquire "${path}" — it is LOCKED by session ` +
              `${result.heldBy}. Back off and retry later, or coordinate with ` +
              `that session.`,
          },
        ],
      };
    }

    const where = branch ? `branch ${branch}` : "no branch";
    let text =
      `Acquired lock on "${path}" (${where}) until ${result.lock.expires_at}.`;

    if (result.warning) {
      const otherBranch = result.warning.otherBranch ?? "(no branch)";
      text +=
        ` WARNING: this path is also locked on ${otherBranch} by session ` +
        `${result.warning.heldBy} — a cross-branch conflict is possible when ` +
        `the branches merge.`;
    }

    // Briefing (M3.5c): surface what recent sessions changed on this path+branch,
    // so the new holder starts informed. A read-only lookup, after the acquire;
    // when there is no history we add no section (graceful, not an error).
    const history = getChanges(db, { repoRoot, path, branch, limit: 5 });
    if (history.length > 0) {
      text += `\n\nRecent changes to this path:\n${history.map(formatChange).join("\n")}`;
    }

    return { content: [{ type: "text", text }] };
  };
}
