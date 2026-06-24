import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import type { Config } from "../../core/config.js";
import { listLocks } from "../../core/lock-engine.js";
import { getCurrentBranch, getRepoRoot } from "../../core/git.js";

/**
 * Input shape for `team_status`. None — the tool surveys every active lock. An
 * empty shape advertises a no-argument tool in tools/list.
 */
export const teamStatusInputSchema = {};

/** Tool name and description, surfaced to the agent in the tools list. */
export const teamStatusToolConfig = {
  description:
    "List all files currently locked across the team, who holds each, and on which branch — to see what's being worked on before you start editing.",
  inputSchema: teamStatusInputSchema,
} as const;

/**
 * Build the `team_status` handler. This tool mutates nothing — it reads every
 * active lock and resolves the agent's own branch so it can mark which locks sit
 * on that branch (the ones that directly contend with the agent's work) versus
 * those that merely coexist on other branches.
 *
 * `config` is accepted for signature consistency with the other tool factories
 * (and forthcoming team-mode needs); team_status reads no config field today.
 * The handler is async because resolving the repo and branch is async.
 *
 * Unlike the per-path tools, team_status has no single path, so it scopes to the
 * DAEMON's repo: getRepoRoot() and getCurrentBranch() both default to cwd. The
 * result is a per-repo survey ("what's locked in this repo").
 */
export function makeTeamStatusHandler(db: MeshLockDatabase, config: Config) {
  void config;
  return async (): Promise<CallToolResult> => {
    const repoRoot = await getRepoRoot();
    const locks = listLocks(db, repoRoot);
    const currentBranch = await getCurrentBranch();

    if (locks.length === 0) {
      return { content: [{ type: "text", text: "No active locks." }] };
    }

    const lines = locks.map((lock) => {
      const branchLabel = lock.branch ?? "no branch";
      // null === null is true, so a branchless agent matches branchless locks —
      // consistent with the engine's "two nulls are the same branch" semantics.
      const mine = lock.branch === currentBranch ? " ← your branch" : "";
      return (
        `- ${lock.path}  [branch: ${branchLabel}]  ` +
        `held by ${lock.session_id}  until ${lock.expires_at}${mine}`
      );
    });

    const header = `${locks.length} active lock${locks.length === 1 ? "" : "s"}:`;
    const text = [header, ...lines].join("\n");
    return { content: [{ type: "text", text }] };
  };
}
