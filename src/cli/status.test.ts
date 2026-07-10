import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { formatStatus } from "./status.js";

let tempDir: string;
let db: MeshLockDatabase;

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";
const MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-status-test-"));
  db = openDatabase(join(tempDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

function seedLive(
  repoRoot: string,
  path: string,
  sessionId: string,
  branch: string | null
): void {
  const result = acquireLock(db, {
    repoRoot,
    path,
    sessionId,
    mode: "exclusive",
    timeoutSeconds: 1800,
    branch,
    crossBranchMode: "ignore",
  });
  expect(result.ok).toBe(true);
}

describe("formatStatus", () => {
  it("reports an empty repo with the no-locks message", () => {
    expect(formatStatus(db, REPO_A, MINE)).toBe(`No active locks in ${REPO_A}.`);
  });

  it("renders own, foreign, and branchless locks with (you), branch dash, and remaining time", () => {
    seedLive(REPO_A, "/repos/alpha/src/mine.ts", MINE, "main");
    seedLive(REPO_A, "/repos/alpha/src/theirs.ts", OTHER, "feature");
    seedLive(REPO_A, "/repos/alpha/src/loose.ts", OTHER, null);

    const out = formatStatus(db, REPO_A, MINE);

    // Header + count line.
    expect(out).toContain(`3 active locks in ${REPO_A}:`);
    expect(out).toContain("PATH");
    expect(out).toContain("HOLDER");
    // Paths are repo-relative.
    expect(out).toContain("src/mine.ts");
    expect(out).toContain("src/theirs.ts");
    // The (you) marker is on OUR row only — exactly one occurrence.
    expect(out.match(/\(you\)/g)).toHaveLength(1);
    expect(out).toContain(`${MINE.slice(0, 8)} (you)`);
    expect(out).toContain(OTHER.slice(0, 8));
    // Branches: named ones verbatim, branchless as "-".
    expect(out).toContain("main");
    expect(out).toContain("feature");
    const looseRow = out.split("\n").find((l) => l.includes("loose.ts"));
    expect(looseRow).toContain(" - ");
    // Mode and a plausible remaining time (seeded 1800s → ~29-30m).
    expect(out).toContain("exclusive");
    expect(out).toMatch(/(29|30)m \d+s/);
  });

  it("omits locks belonging to a DIFFERENT repo_root (S1 discipline)", () => {
    seedLive(REPO_B, "/repos/beta/src/other.ts", OTHER, "main");

    expect(formatStatus(db, REPO_A, MINE)).toBe(`No active locks in ${REPO_A}.`);
  });

  it("falls back to the absolute path when relative() is empty (lock on the repo root itself)", () => {
    // A directory-level lock ON the repo root: relative() gives "", which must
    // not render as an empty path cell — the row falls back to the absolute.
    seedLive(REPO_A, REPO_A, OTHER, "main");

    const out = formatStatus(db, REPO_A, MINE);
    const dataRow = out.split("\n").find((l) => l.startsWith(REPO_A));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain(OTHER.slice(0, 8));
  });
});
