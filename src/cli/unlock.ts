import { dirname } from "node:path";
import type { MeshLockDatabase } from "../core/db.js";
import type { Config } from "../core/config.js";
import { forceReleaseLock } from "../core/lock-engine.js";
import { canonicalizePath } from "../core/paths.js";
import { getRepoRoot } from "../core/git.js";
import { makeReleaseLockHandler } from "../mcp/tools/release-lock.js";

export interface UnlockDeps {
  db: MeshLockDatabase;
  config: Config;
  /** As typed by the user — canonicalized here, the tool-boundary rule (M6.1). */
  rawPath: string;
  /** true = break OTHER sessions' locks too. The flag IS the consent. */
  force: boolean;
}

export interface UnlockResult {
  exitCode: 0 | 1;
  /** The command's product, printed to stdout by the CLI. */
  message: string;
}

/** Pull the plain text out of a CallToolResult (shape guaranteed by our handler). */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) {
    throw new Error("release handler returned no text block");
  }
  return block.text;
}

/**
 * Release the lock(s) on one path from the command line.
 *
 * OWN path (default): delegate to the MCP release handler VERBATIM — same
 * ownership scoping, same change-briefing recording, same message an agent
 * would see. A nothing-to-release outcome is a no-op, not an error: exit 0.
 *
 * FORCE path: the human override. forceReleaseLock drops EVERY session's rows
 * on the path (live and expired), the message names each deleted claim, and
 * NO change briefing is recorded — a forced release ends a lock abnormally;
 * there is no releasing session whose edits a diff could honestly describe.
 * No confirmation prompt: --force is itself the consent, and hooks/scripts
 * must stay non-interactive.
 */
export async function unlockPath(deps: UnlockDeps): Promise<UnlockResult> {
  const path = canonicalizePath(deps.rawPath);

  if (!deps.force) {
    const handler = makeReleaseLockHandler(deps.db, deps.config);
    const result = await handler({ path });
    return { exitCode: 0, message: firstText(result) };
  }

  const repoRoot = await getRepoRoot(dirname(path));
  // Clock BEFORE the delete: the live/expired label should describe each lock
  // as it was at deletion, not microseconds after.
  const now = new Date().toISOString();
  const deleted = forceReleaseLock(deps.db, repoRoot, path);

  if (deleted.length === 0) {
    return { exitCode: 0, message: `No locks on ${path}.` };
  }
  const lines = deleted.map((lock) => {
    const state = lock.expires_at > now ? "was live" : "already expired";
    return `  ${lock.session_id.slice(0, 8)}  branch ${lock.branch ?? "-"}  ${state}, expiry ${lock.expires_at}`;
  });
  const plural = deleted.length === 1 ? "" : "s";
  return {
    exitCode: 0,
    message: [
      `Force-released ${String(deleted.length)} lock${plural} on ${path}:`,
      ...lines,
      "No change briefing was recorded — forced release ends a lock abnormally.",
    ].join("\n"),
  };
}
