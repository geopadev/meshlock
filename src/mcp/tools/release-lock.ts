import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import type { Config } from "../../core/config.js";
import { releaseLock } from "../../core/lock-engine.js";
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
 * M3.5c closes the change-briefing loop; M5.1c tightened it: releaseLock now
 * returns the row(s) it deleted, each carrying its branch and acquire-time
 * baseline, so the tool diffs/records AFTER the engine call with no pre-read
 * checkLock. The engine itself never diffs or records — those are filesystem/
 * process operations and stay in the tool (M3.5b discipline).
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

    // The engine hands back the row(s) it deleted (M5.1c), each with its branch
    // and acquire-time baseline snapshot. Ownership scoping means every returned
    // row was OURS — a foreign lock can never be diffed against here. Intended
    // consequences of recording off the deleted rows:
    //  - an EXPIRED-but-owned release now RECORDS (the deleted row still carries
    //    the baseline — closes the M3.5c lost-record gap, where checkLock
    //    reported the expired row as free and the diff was silently dropped);
    //  - a multi-branch own release records ONE change per branch, each diffed
    //    against that branch's own baseline.
    const deleted = releaseLock(db, { repoRoot, path, sessionId: config.session_id });

    if (deleted.length > 0) {
      // One read serves every deleted row: they all name the same file — only
      // the baselines differ per branch.
      const current = readCurrentContent(path); // content now (null if gone/unreadable)

      for (const row of deleted) {
        const snapshot = row.content_snapshot; // baseline at acquire (may be null)

        // Binary guard, per row: if EITHER side carries a NUL byte, skip
        // diff+record for THIS row (no change_log row, no error) rather than
        // store a corrupt diff.
        const binary =
          (current !== null && looksBinary(current)) ||
          (snapshot !== null && looksBinary(snapshot));
        if (binary) continue;

        // diff is the FLOOR — always recorded, "" for a no-op (M3.5a). A null
        // baseline (new file) diffs against "" → all additions; a vanished current
        // file → "" → all deletions.
        const diff = diffContent(snapshot ?? "", current ?? "");
        recordChange(db, {
          repoRoot,
          path,
          branch: row.branch,
          sessionId: config.session_id,
          diff,
          summary: summary ?? null,
          changedAt: new Date().toISOString(),
        });
      }
    }

    const text =
      deleted.length > 0
        ? `Released lock on "${path}".`
        : `Nothing to release on "${path}" — you don't hold a lock there.`;

    return { content: [{ type: "text", text }] };
  };
}
