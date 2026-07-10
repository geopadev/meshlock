import { relative } from "node:path";
import type { MeshLockDatabase } from "../core/db.js";
import { listLocks } from "../core/lock-engine.js";

/**
 * Human time-remaining until an ISO expiry: "1h 3m", "12m 4s", "45s". Floors
 * negatives to "0s" — listLocks already filters expired rows, so a negative
 * can only appear in the instant between query and format; no "expired" branch.
 */
function timeRemaining(expiresAt: string): string {
  const totalSeconds = Math.max(
    0,
    Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

/** Left-pad-free column alignment: widen every cell to its column's max. */
function alignRows(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((row) => row[col]!.length))
  );
  return rows.map((row) =>
    row.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd()
  );
}

/**
 * Render the repo's live locks as plain aligned text — the PRODUCT of
 * `meshlock status`, printed to stdout by the CLI. Pure read: one repo-scoped
 * listLocks (S1 discipline — another repo's locks never appear), no writes,
 * no side effects. `sessionId` is only used to mark which rows are YOURS.
 */
export function formatStatus(
  db: MeshLockDatabase,
  repoRoot: string,
  sessionId: string
): string {
  const locks = listLocks(db, repoRoot);
  if (locks.length === 0) {
    return `No active locks in ${repoRoot}.`;
  }

  const header = ["PATH", "HOLDER", "BRANCH", "MODE", "REMAINING"];
  const rows = locks.map((lock) => {
    const rel = relative(repoRoot, lock.path) || lock.path;
    const holder =
      lock.session_id.slice(0, 8) +
      (lock.session_id === sessionId ? " (you)" : "");
    return [rel, holder, lock.branch ?? "-", lock.mode, timeRemaining(lock.expires_at)];
  });

  const plural = locks.length === 1 ? "" : "s";
  return [
    `${String(locks.length)} active lock${plural} in ${repoRoot}:`,
    ...alignRows([header, ...rows]),
  ].join("\n");
}
