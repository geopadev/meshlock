import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { getRepoRoot } from "../core/git.js";
import { makeCheckLockHandler } from "./tools/check-lock.js";

let tempDir: string;
let db: MeshLockDatabase;

const SESSION = "33333333-3333-4333-8333-333333333333";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-mcp-test-"));
  db = openDatabase(join(tempDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

/** Pull the plain text out of a CallToolResult for assertions. */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) {
    throw new Error("expected a text content block");
  }
  return block.text;
}

describe("check_lock handler", () => {
  it("reports a free path as free", async () => {
    const handler = makeCheckLockHandler(db);
    const text = firstText(await handler({ path: "/repo/unlocked.ts" }));
    expect(text).toContain("FREE");
    expect(text).toContain("/repo/unlocked.ts");
  });

  it("reports a held path with the holding session", async () => {
    const path = "/repo/locked.ts";
    // Seed with the same repo_root the handler will resolve from the path's dir.
    const repoRoot = await getRepoRoot(dirname(path));
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });

    const handler = makeCheckLockHandler(db);
    const text = firstText(await handler({ path }));

    expect(text).toContain("LOCKED");
    expect(text).toContain(SESSION);
    expect(text).toContain("exclusive");
  });
});
