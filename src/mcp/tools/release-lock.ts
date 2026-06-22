import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import type { Config } from "../../core/config.js";
import { releaseLock } from "../../core/lock-engine.js";

/**
 * Input shape for `release_lock`. Only `path` — release is branch-agnostic, so
 * the agent never supplies a branch.
 */
export const releaseLockInputSchema = {
  path: z
    .string()
    .describe("The file or directory path to release a lock you previously acquired."),
};

/** Tool name and description, surfaced to the agent in the tools list. */
export const releaseLockToolConfig = {
  description:
    "Release a lock you hold on a file path when you are done editing it, so other agents can take it.",
  inputSchema: releaseLockInputSchema,
} as const;

/**
 * Build the `release_lock` handler bound to a database and the loaded config.
 * Config supplies session_id — release is ownership-scoped, so we only delete
 * locks held by the calling session. No git, no branch: releasing a path drops
 * all of this session's locks on it across every branch (decided in M3.2b).
 */
export function makeReleaseLockHandler(db: MeshLockDatabase, config: Config) {
  return ({ path }: { path: string }): CallToolResult => {
    const released = releaseLock(db, { path, sessionId: config.session_id });

    const text = released
      ? `Released lock on "${path}".`
      : `Nothing to release on "${path}" — you don't hold a lock there.`;

    return { content: [{ type: "text", text }] };
  };
}
