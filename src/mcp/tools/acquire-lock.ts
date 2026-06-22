import { dirname } from "node:path";
import { z } from "zod";
import { simpleGit } from "simple-git";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import type { Config } from "../../core/config.js";
import { acquireLock } from "../../core/lock-engine.js";

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
 * Resolve the current git branch for the repo containing `repoDir`. Returns null
 * when there is no usable branch — not a git repo, detached HEAD, or any git
 * failure. MeshLock does not hard-require git, so this NEVER throws: a null
 * branch is the engine's "branchless" case, decided in M2.5.
 */
async function resolveBranch(repoDir: string): Promise<string | null> {
  try {
    const branch = (
      await simpleGit(repoDir).revparse(["--abbrev-ref", "HEAD"])
    ).trim();
    // "HEAD" means detached; empty means no branch. Both are branchless.
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Build the `acquire_lock` handler bound to a database and the loaded config.
 * Config supplies session_id / lock_mode / lock_timeout / cross_branch_mode so
 * the handler never re-reads config per call. The handler is async because
 * resolving the branch is async — but that git I/O happens BEFORE the
 * synchronous engine call, never inside its transaction.
 */
export function makeAcquireLockHandler(db: MeshLockDatabase, config: Config) {
  return async ({ path }: { path: string }): Promise<CallToolResult> => {
    const branch = await resolveBranch(dirname(path));

    const result = acquireLock(db, {
      path,
      sessionId: config.session_id,
      mode: config.lock_mode,
      timeoutSeconds: config.lock_timeout,
      branch,
      crossBranchMode: config.cross_branch_mode,
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

    return { content: [{ type: "text", text }] };
  };
}
