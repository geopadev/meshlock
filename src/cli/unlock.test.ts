import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { getChanges } from "../core/changes.js";
import { getRepoRoot } from "../core/git.js";
import type { Config } from "../core/config.js";
import { unlockPath } from "./unlock.js";

let tempDir: string;
let db: MeshLockDatabase;
// The repo_root both the release handler and the force path resolve from the
// file's directory (tempDir is not a git repo → its realpath sentinel).
let repoRoot: string;

const CONFIG_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function makeConfig(): Config {
  return {
    mode: "solo",
    session_id: CONFIG_SESSION,
    relay_url: null,
    lock_timeout: 1800,
    lock_mode: "exclusive",
    granularity: "file",
    cross_branch_mode: "warn",
  };
}

function rowCount(path: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM locks WHERE path = ?").get(path) as {
      n: number;
    }
  ).n;
}

function seedLive(path: string, sessionId: string, branch: string | null): void {
  const result = acquireLock(db, {
    repoRoot,
    path,
    sessionId,
    mode: "exclusive",
    timeoutSeconds: 1800,
    branch,
    crossBranchMode: "ignore",
    contentSnapshot: "baseline\n",
  });
  expect(result.ok).toBe(true);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-unlock-test-"));
  db = openDatabase(join(tempDir, "test.db"));
  repoRoot = await getRepoRoot(tempDir);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("unlockPath — own (default)", () => {
  it("releases the session's own lock AND records a change_log row (handler reuse)", async () => {
    const path = join(tempDir, "mine.ts");
    await writeFile(path, "baseline\n");
    seedLive(path, CONFIG_SESSION, null);

    const result = await unlockPath({
      db,
      config: makeConfig(),
      rawPath: path,
      force: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Released");
    expect(rowCount(path)).toBe(0);
    // The proof this went through the REAL MCP handler: the release recorded
    // a briefing row, exactly as an agent's release would.
    expect(getChanges(db, { repoRoot, path })).toHaveLength(1);
  });

  it("is a no-op (exit 0) on a foreign-only lock, which survives", async () => {
    const path = join(tempDir, "theirs.ts");
    await writeFile(path, "baseline\n");
    seedLive(path, OTHER_SESSION, null);

    const result = await unlockPath({
      db,
      config: makeConfig(),
      rawPath: path,
      force: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Nothing to release");
    expect(rowCount(path)).toBe(1);
  });
});

describe("unlockPath — force", () => {
  it("deletes foreign rows, lists each holder, warns, and records NO briefing", async () => {
    const path = join(tempDir, "contested.ts");
    await writeFile(path, "baseline\n");
    seedLive(path, OTHER_SESSION, "main");
    seedLive(path, CONFIG_SESSION, "feature");

    const result = await unlockPath({
      db,
      config: makeConfig(),
      rawPath: path,
      force: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Force-released 2 locks");
    expect(result.message).toContain(OTHER_SESSION.slice(0, 8));
    expect(result.message).toContain(CONFIG_SESSION.slice(0, 8));
    expect(result.message).toContain("branch main");
    expect(result.message).toContain(
      "No change briefing was recorded — forced release ends a lock abnormally."
    );
    expect(rowCount(path)).toBe(0);
    // Force NEVER records: an abnormal end has no honest diff to write.
    expect(getChanges(db, { repoRoot, path })).toHaveLength(0);
  });

  it("reports no-locks (exit 0) on an unlocked path", async () => {
    const path = join(tempDir, "empty.ts");

    const result = await unlockPath({
      db,
      config: makeConfig(),
      rawPath: path,
      force: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`No locks on ${path}.`);
  });
});
