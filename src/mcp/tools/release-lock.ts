import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import type { Config } from "../../core/config.js";
import { checkLock, releaseLock } from "../../core/lock-engine.js";
import { getRepoRoot } from "../../core/git.js";
import { diffContent } from "../../core/diff.js";
import { recordChange } from "../../core/changes.js";

/**
 * Input shape for `release_lock`. `path` is required; `summary` is optional
 * enrichment — a human/agent sentence describing what changed, recorded next to
 * the (always-computed) diff to brief the next acquirer.
 */
export const releaseLockInputSchema = {
  path: z
    .string()
    .describe("The file or directory path to release a lock you previously acquired."),
  summary: z
    .string()
    .optional()
    .describe(
      "Optional one-line summary of what you changed, recorded with the diff to brief the next agent."
    ),
};

/** Tool name and description, surfaced to the agent in the tools list. */
export const releaseLockToolConfig = {
  description:
    "Release a lock you hold on a file path when you are done editing it, so other agents can take it.",
  inputSchema: releaseLockInputSchema,
} as const;

/** Read the file's current content, or null if it is missing/unreadable. */
function readCurrentContent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * A NUL byte is the standard cheap heuristic for "not text". captureSnapshot and
 * this read both decode as utf-8, which is lossy for binary, so a diff of binary
 * content would be garbage. The check lives HERE, at the tool boundary, not inside
 * diffContent: diffContent's single job is to diff: the caller decides whether a
 * diff is even applicable.
 */
function looksBinary(content: string): boolean {
  return content.includes("\0");
}

/**
 * Build the `release_lock` handler bound to a database and the loaded config.
 * Config supplies session_id — release is ownership-scoped, so we only delete
 * locks held by the calling session. Repo-scoped (repo_root resolved from the
 * file's directory) but still branch-agnostic: releasing a path drops all of
 * this session's locks on it across every branch in that repo (decided in M3.2b).
 *
 * M3.5c closes the change-briefing loop: BEFORE releasing we read the lock row
 * (the engine returns its content_snapshot baseline), then around the pure engine
 * call the tool does read→diff→record. The engine itself never diffs or records —
 * those are filesystem/process operations and stay in the tool (M3.5b discipline).
 */
export function makeReleaseLockHandler(db: MeshLockDatabase, config: Config) {
  return async ({
    path,
    summary,
  }: {
    path: string;
    summary?: string;
  }): Promise<CallToolResult> => {
    const repoRoot = await getRepoRoot(dirname(path));

    // Capture the lock row (with its baseline snapshot + branch) BEFORE releasing,
    // because releaseLock deletes it.
    const held = checkLock(db, repoRoot, path);
    const released = releaseLock(db, { repoRoot, path, sessionId: config.session_id });

    // Record what changed — only when WE actually released a live lock we held.
    // released === true ⇒ we owned the row; held.held ⇒ it was live, so its
    // baseline is available. (An expired-but-owned release has no live snapshot to
    // diff against, so it records nothing.)
    if (released && held.held) {
      const snapshot = held.lock.content_snapshot; // baseline at acquire (may be null)
      const current = readCurrentContent(path); // content now (null if gone/unreadable)

      // Binary guard: if EITHER side carries a NUL byte, skip diff+record entirely
      // (no change_log row, no error) rather than store a corrupt diff.
      const binary =
        (current !== null && looksBinary(current)) ||
        (snapshot !== null && looksBinary(snapshot));

      if (!binary) {
        // diff is the FLOOR — always recorded, "" for a no-op (M3.5a). A null
        // baseline (new file) diffs against "" → all additions; a vanished current
        // file → "" → all deletions.
        const diff = diffContent(snapshot ?? "", current ?? "");
        recordChange(db, {
          repoRoot,
          path,
          branch: held.lock.branch,
          sessionId: config.session_id,
          diff,
          summary: summary ?? null,
          changedAt: new Date().toISOString(),
        });
      }
    }

    const text = released
      ? `Released lock on "${path}".`
      : `Nothing to release on "${path}" — you don't hold a lock there.`;

    return { content: [{ type: "text", text }] };
  };
}
