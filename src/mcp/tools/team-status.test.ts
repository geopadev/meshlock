import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../../core/db.js";
import { acquireLock } from "../../core/lock-engine.js";
import type { Config } from "../../core/config.js";
import { clearBranchCache, getRepoRoot } from "../../core/git.js";
import { makeTeamStatusHandler } from "./team-status.js";

// team_status resolves the agent's branch from process.cwd(). We chdir into a
// non-git temp dir per test so "your branch" resolves to null deterministically.
const ORIGINAL_CWD = process.cwd();

let tempDir: string;
let db: MeshLockDatabase;
// The repo_root the handler resolves from cwd (== tempDir after chdir). Seeds use
// the same value so the per-repo survey returns them.
let repoRoot: string;

const SESSION_A = "88888888-8888-4888-8888-888888888888";
const SESSION_B = "99999999-9999-4999-8999-999999999999";

function makeConfig(): Config {
  return {
    mode: "solo",
    session_id: SESSION_A,
    relay_url: null,
    lock_timeout: 1800,
    lock_mode: "exclusive",
    granularity: "file",
    cross_branch_mode: "warn",
  };
}

/** Pull the plain text out of a CallToolResult for assertions. */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) {
    throw new Error("expected a text content block");
  }
  return block.text;
}

/** Find the single output line mentioning `path`. */
function lineFor(text: string, path: string): string {
  const line = text.split("\n").find((l) => l.includes(path));
  if (line === undefined) throw new Error(`no line for ${path}`);
  return line;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-status-test-"));
  db = openDatabase(join(tempDir, "test.db"));
  process.chdir(tempDir);
  clearBranchCache();
  repoRoot = await getRepoRoot();
});

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("team_status handler", () => {
  it("reports no active locks when the table is empty", async () => {
    const handler = makeTeamStatusHandler(db, makeConfig());
    const text = firstText(await handler());
    expect(text).toContain("No active locks");
  });

  it("lists every active lock with path, branch, and holder", async () => {
    acquireLock(db, {
      repoRoot,
      path: join(tempDir, "a.ts"),
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    acquireLock(db, {
      repoRoot,
      path: join(tempDir, "b.ts"),
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });
    acquireLock(db, {
      repoRoot,
      path: join(tempDir, "c.ts"),
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
    });

    const handler = makeTeamStatusHandler(db, makeConfig());
    const text = firstText(await handler());

    expect(text).toContain("3 active locks");
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).toContain("c.ts");
    expect(text).toContain("main");
    expect(text).toContain("feature");
    expect(text).toContain("no branch");
    expect(text).toContain(SESSION_A);
    expect(text).toContain(SESSION_B);
  });

  it("marks own-branch locks, including the branchless (null) case", async () => {
    // cwd is a non-git dir, so the agent's branch resolves to null.
    const branchlessPath = join(tempDir, "mine.ts");
    const namedPath = join(tempDir, "theirs.ts");
    acquireLock(db, {
      repoRoot,
      path: branchlessPath,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });
    acquireLock(db, {
      repoRoot,
      path: namedPath,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const handler = makeTeamStatusHandler(db, makeConfig());
    const text = firstText(await handler());

    // null === null: the branchless lock is on "our" branch and is marked.
    expect(lineFor(text, branchlessPath)).toContain("your branch");
    // The named-branch lock is not ours and is not marked.
    expect(lineFor(text, namedPath)).not.toContain("your branch");
  });

  it("excludes expired locks (reads listLocks)", async () => {
    const expiredPath = join(tempDir, "stale.ts");
    // Seed a row that already expired, bypassing acquireLock's future expiry.
    db.prepare(
      `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      repoRoot,
      expiredPath,
      SESSION_B,
      "exclusive",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:30:00.000Z",
      null
    );

    const handler = makeTeamStatusHandler(db, makeConfig());
    const text = firstText(await handler());

    expect(text).toContain("No active locks");
    expect(text).not.toContain(expiredPath);
  });
});
