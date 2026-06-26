import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "./db.js";
import { recordChange, getChanges, type ChangeRecord } from "./changes.js";

let tempDir: string;
let db: MeshLockDatabase;

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";
const SESSION = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-changes-test-"));
  db = openDatabase(join(tempDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

/** A complete record with every field populated, for round-trip tests. */
function fullRecord(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    repoRoot: REPO_A,
    path: "/repos/alpha/src/index.ts",
    branch: "main",
    sessionId: SESSION,
    diff: "@@ -1 +1 @@\n-old\n+new\n",
    summary: "renamed a thing",
    diffStat: "1 file, +1 -1",
    changedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("recordChange / getChanges", () => {
  it("round-trips a fully populated record", () => {
    const record = fullRecord();
    recordChange(db, record);

    const rows = getChanges(db, { repoRoot: REPO_A, path: record.path });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(record);
  });

  it("isolates change history per repository (S1 cross-repo discipline)", () => {
    const path = "/shared/path/file.ts";
    recordChange(db, fullRecord({ repoRoot: REPO_A, path, diff: "alpha-diff" }));
    recordChange(db, fullRecord({ repoRoot: REPO_B, path, diff: "beta-diff" }));

    const fromA = getChanges(db, { repoRoot: REPO_A, path });
    const fromB = getChanges(db, { repoRoot: REPO_B, path });

    expect(fromA).toHaveLength(1);
    expect(fromA[0]!.diff).toBe("alpha-diff");
    expect(fromB).toHaveLength(1);
    expect(fromB[0]!.diff).toBe("beta-diff");
  });

  it("degrades gracefully with no summary or diff_stat (stored as NULL)", () => {
    // Omit the optional enrichment entirely — must not throw, must read back null.
    const record: ChangeRecord = {
      repoRoot: REPO_A,
      path: "/repos/alpha/bare.ts",
      branch: "main",
      sessionId: SESSION,
      diff: "+something\n",
      changedAt: "2026-06-01T00:00:00.000Z",
    };
    expect(() => recordChange(db, record)).not.toThrow();

    const rows = getChanges(db, { repoRoot: REPO_A, path: record.path });
    expect(rows[0]!.summary).toBeNull();
    expect(rows[0]!.diffStat).toBeNull();
  });

  it("stores an empty diff — the floor still records a no-op change", () => {
    const record = fullRecord({ path: "/repos/alpha/noop.ts", diff: "" });
    recordChange(db, record);

    const rows = getChanges(db, { repoRoot: REPO_A, path: record.path });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.diff).toBe("");
  });

  it("returns changes most-recent-first by changed_at", () => {
    const path = "/repos/alpha/history.ts";
    recordChange(db, fullRecord({ path, changedAt: "2026-06-01T00:00:00.000Z", diff: "first" }));
    recordChange(db, fullRecord({ path, changedAt: "2026-06-01T00:00:02.000Z", diff: "third" }));
    recordChange(db, fullRecord({ path, changedAt: "2026-06-01T00:00:01.000Z", diff: "second" }));

    const rows = getChanges(db, { repoRoot: REPO_A, path });
    expect(rows.map((r) => r.diff)).toEqual(["third", "second", "first"]);
  });

  it("breaks changed_at ties by insertion order (id DESC), newest insert first", () => {
    const path = "/repos/alpha/tie.ts";
    const ts = "2026-06-01T00:00:00.000Z";
    recordChange(db, fullRecord({ path, changedAt: ts, diff: "earlier-insert" }));
    recordChange(db, fullRecord({ path, changedAt: ts, diff: "later-insert" }));

    const rows = getChanges(db, { repoRoot: REPO_A, path });
    expect(rows.map((r) => r.diff)).toEqual(["later-insert", "earlier-insert"]);
  });

  it("respects the limit, keeping the most recent", () => {
    const path = "/repos/alpha/many.ts";
    for (let i = 0; i < 5; i++) {
      const stamp = `2026-06-01T00:00:0${String(i)}.000Z`;
      recordChange(db, fullRecord({ path, changedAt: stamp, diff: `change-${String(i)}` }));
    }

    const rows = getChanges(db, { repoRoot: REPO_A, path, limit: 2 });
    expect(rows.map((r) => r.diff)).toEqual(["change-4", "change-3"]);
  });

  describe("branch filtering", () => {
    const path = "/repos/alpha/branched.ts";

    beforeEach(() => {
      recordChange(db, fullRecord({ path, branch: "main", diff: "on-main" }));
      recordChange(db, fullRecord({ path, branch: "feature", diff: "on-feature" }));
      recordChange(db, fullRecord({ path, branch: null, diff: "branchless" }));
    });

    it("returns every branch's changes when branch is omitted", () => {
      const rows = getChanges(db, { repoRoot: REPO_A, path });
      expect(rows.map((r) => r.diff).sort()).toEqual(["branchless", "on-feature", "on-main"]);
    });

    it("filters to a named branch", () => {
      const rows = getChanges(db, { repoRoot: REPO_A, path, branch: "feature" });
      expect(rows.map((r) => r.diff)).toEqual(["on-feature"]);
    });

    it("filters to branchless changes with explicit null (null-safe IS)", () => {
      const rows = getChanges(db, { repoRoot: REPO_A, path, branch: null });
      expect(rows.map((r) => r.diff)).toEqual(["branchless"]);
    });
  });
});

describe("change_log schema", () => {
  it("creates the change_log table with all nine columns", () => {
    const columns = db
      .prepare("PRAGMA table_info(change_log)")
      .all() as { name: string; notnull: number; pk: number }[];

    const byName = new Map(columns.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual([
      "branch",
      "changed_at",
      "diff",
      "diff_stat",
      "id",
      "path",
      "repo_root",
      "session_id",
      "summary",
    ]);

    // The floor columns are NOT NULL; the enrichment columns are nullable.
    expect(byName.get("repo_root")!.notnull).toBe(1);
    expect(byName.get("path")!.notnull).toBe(1);
    expect(byName.get("session_id")!.notnull).toBe(1);
    expect(byName.get("diff")!.notnull).toBe(1);
    expect(byName.get("changed_at")!.notnull).toBe(1);
    expect(byName.get("branch")!.notnull).toBe(0);
    expect(byName.get("summary")!.notnull).toBe(0);
    expect(byName.get("diff_stat")!.notnull).toBe(0);
    // id is the surrogate primary key.
    expect(byName.get("id")!.pk).toBe(1);
  });

  it("creates the lookup index over (repo_root, path, branch)", () => {
    const indexes = db.prepare("PRAGMA index_list(change_log)").all() as {
      name: string;
    }[];
    const lookup = indexes.find((i) => i.name === "idx_change_log_lookup");
    expect(lookup).toBeDefined();

    const cols = (
      db.prepare("PRAGMA index_info(idx_change_log_lookup)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(["repo_root", "path", "branch"]);
  });
});
