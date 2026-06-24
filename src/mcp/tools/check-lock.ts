import { dirname } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import { checkLock } from "../../core/lock-engine.js";
import { getRepoRoot } from "../../core/git.js";

/**
 * Input shape for `check_lock`, as a Zod raw shape. The SDK turns this into the
 * tool's JSON schema and hands the handler the parsed, validated args.
 */
export const checkLockInputSchema = {
  path: z
    .string()
    .describe("The file or directory path to check, e.g. /repo/src/index.ts"),
};

/** Tool name and description, surfaced to the agent in the tools list. */
export const checkLockToolConfig = {
  description:
    "Check whether a file path is currently locked, and by whom, before modifying it.",
  inputSchema: checkLockInputSchema,
} as const;

/**
 * Build the `check_lock` handler bound to a specific database. The DB is passed
 * in (not opened here) so the connection is created once by the server and not
 * per call — and so tests can supply a temp DB. Async because it resolves the
 * lock's repo (from the file's directory) before the lookup.
 */
export function makeCheckLockHandler(db: MeshLockDatabase) {
  return async ({ path }: { path: string }): Promise<CallToolResult> => {
    const repoRoot = await getRepoRoot(dirname(path));
    const result = checkLock(db, repoRoot, path);

    const text = result.held
      ? `Path "${path}" is LOCKED by session ${result.lock.session_id} ` +
        `in ${result.lock.mode} mode until ${result.lock.expires_at} ` +
        `(acquired ${result.lock.acquired_at}).`
      : `Path "${path}" is FREE — no active lock.`;

    return { content: [{ type: "text", text }] };
  };
}
