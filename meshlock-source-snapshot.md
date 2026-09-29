# MeshLock source snapshot — 2026-09-10


=== src/cli/index.ts ===
#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { startServer } from "../mcp/server.js";
import { openDatabase } from "../core/db.js";
import { getDatabasePath, loadConfig } from "../core/config.js";
import { getRepoRoot } from "../core/git.js";
import { startDaemon } from "../daemon/index.js";
import { installHook } from "../hooks/install.js";
import { runPreCommit } from "../hooks/run.js";
import { formatStatus } from "./status.js";
import { unlockPath } from "./unlock.js";
import {
  getClaudeConfigPath,
  registerMeshlock,
  type StdioServerEntry,
} from "./init.js";

function usage(): string {
  return [
    "Usage: meshlock <command>",
    "",
    "Commands:",
    "  init              Register the meshlock MCP server in Claude Code's user config",
    "  serve             Start the MCP server over stdio (how Claude Code launches it)",
    "  status            Show the current repo's active locks",
    "  unlock <file> [--force]",
    "                    Release your own lock on a file; --force removes ANY",
    "                    session's locks (no change briefing is recorded)",
    "  watch             Watch the current repo and warn about edits to unlocked paths",
    "  install-hook      Install the pre-commit lock gate into this repo's .git/hooks",
    "  hook pre-commit   Run the pre-commit gate (invoked by the installed hook)",
    "",
    "With no command, meshlock runs `serve`.",
  ].join("\n");
}

/**
 * Build the registration entry that launches THIS CLI's `serve` path. `command`
 * is the PATH-relative "node" (not process.execPath): a pinned nvm-style path
 * like .../v22.x/bin/node vanishes on a Node upgrade and SILENTLY un-registers
 * meshlock. "node" resolves via PATH and survives upgrades. Its tradeoff (the
 * wrong node first on PATH) is a rare, LOUD failure — serve visibly won't start
 * — which is preferable to a silent disappearance. `args` keeps the absolute
 * path to this compiled entry, so the script location doesn't depend on cwd.
 */
function meshlockServerEntry(): StdioServerEntry {
  const selfPath = fileURLToPath(import.meta.url);
  return {
    type: "stdio",
    command: "node",
    args: [selfPath, "serve"],
    env: {},
  };
}

async function runInit(): Promise<void> {
  const result = await registerMeshlock(getClaudeConfigPath(), meshlockServerEntry());
  const verb = result.created
    ? "Created"
    : result.replaced
      ? "Updated meshlock entry in"
      : "Registered meshlock in";
  // `init` is a normal command, not the protocol channel, so stdout is fine here.
  console.log(`${verb} ${result.configPath}`);
  console.log("Restart Claude Code (or reload its MCP servers) to pick up the tools.");
}

/**
 * Long-running detector: watch the repo containing cwd and warn (stderr) about
 * edits to paths without a live lock. The CLI layer owns everything process-
 * shaped — config/DB/repo assembly, signals, exit — while startDaemon stays a
 * pure factory. The chokidar handles keep the event loop alive after main()
 * returns; SIGINT/SIGTERM tear down watcher then DB, then exit 0.
 */
async function runWatch(): Promise<void> {
  // Validate the config file up front (throws loudly on a corrupt one). The
  // daemon consumes no config values yet — this is purely fail-fast.
  await loadConfig();
  const db = openDatabase(getDatabasePath());
  const repoRoot = await getRepoRoot(process.cwd());
  const daemon = startDaemon({ db, repoRoot }); // default sink: stderr

  const shutdown = (): void => {
    void daemon.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await daemon.ready;
  // Banner on stderr — stdout stays clean by project discipline.
  process.stderr.write(`[meshlock] watching ${repoRoot} (Ctrl-C to stop)\n`);
}

/**
 * Install the pre-commit shim into the repo containing cwd. A refusal (foreign
 * hook, not a repo) exits 1 with the reason — installHook never clobbers.
 */
async function runInstallHook(): Promise<void> {
  const repoRoot = await getRepoRoot(process.cwd());
  const result = installHook(repoRoot);
  if (!result.installed) {
    console.error(`install-hook: ${result.reason}`);
    process.exit(1);
  }
  console.log(
    `${result.replaced ? "Updated" : "Installed"} pre-commit hook at ${result.hookPath}`
  );
  console.log("Commits staging paths locked by other sessions will now be blocked.");
}

/**
 * The shim's entry: assemble deps (config for session identity, the real DB,
 * cwd = where git invoked the hook), run the gate, report on STDERR (stdout
 * discipline: hooks shouldn't pollute it), exit with the verdict.
 *
 * FAIL-OPEN, belt #2: runPreCommit already catches its own internals, but the
 * deps assembly here (config load, DB open) can throw BEFORE the runtime gets
 * control. Any such failure exits 0 with a warning — exit 1 is reserved for a
 * positive conflict verdict, never for meshlock's own breakage.
 */
async function runHookPreCommit(): Promise<void> {
  try {
    const config = await loadConfig();
    const db = openDatabase(getDatabasePath());
    const result = await runPreCommit({
      db,
      cwd: process.cwd(),
      sessionId: config.session_id,
    });
    db.close();
    if (result.message !== null) {
      process.stderr.write(`${result.message}\n`);
    }
    process.exit(result.exitCode);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[meshlock] pre-commit check skipped (fail-open): ${detail}\n`);
    process.exit(0);
  }
}

/**
 * One-shot read: render the repo's live locks to STDOUT — the status IS the
 * command's product, not a diagnostic (unlike watch's stderr warnings). Config
 * supplies the session identity so the user's own rows carry the (you) marker.
 */
async function runStatus(): Promise<void> {
  const config = await loadConfig();
  const db = openDatabase(getDatabasePath());
  try {
    const repoRoot = await getRepoRoot(process.cwd());
    console.log(formatStatus(db, repoRoot, config.session_id));
  } finally {
    db.close();
  }
}

/**
 * STRICT argument parsing — the CLI's first flag, so start the discipline:
 * argv after `unlock` must be exactly `<file>` plus at most one `--force`, in
 * either order. Anything else refuses with exit 1 naming the offender. A
 * typo'd flag silently treated as a filename (or a second path silently
 * ignored) would be a destructive command guessing at intent.
 */
async function runUnlock(args: string[]): Promise<void> {
  const rest = args.filter((a) => a !== "--force");
  const forceCount = args.length - rest.length;
  const unknownFlag = rest.find((a) => a.startsWith("-"));
  if (unknownFlag !== undefined) {
    console.error(`unlock: unknown flag ${unknownFlag}\n\n${usage()}`);
    process.exit(1);
  }
  if (forceCount > 1) {
    console.error(`unlock: --force given more than once\n\n${usage()}`);
    process.exit(1);
  }
  if (rest.length === 0) {
    console.error(`unlock: missing <file> argument\n\n${usage()}`);
    process.exit(1);
  }
  if (rest.length > 1) {
    console.error(`unlock: unexpected argument ${rest[1]!}\n\n${usage()}`);
    process.exit(1);
  }

  const config = await loadConfig();
  const db = openDatabase(getDatabasePath());
  try {
    const result = await unlockPath({
      db,
      config,
      rawPath: rest[0]!,
      force: forceCount === 1,
    });
    // The message is the product → stdout; exitCode set without process.exit
    // so the finally still closes the DB.
    console.log(result.message);
    process.exitCode = result.exitCode;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "init":
      await runInit();
      return;
    case "status":
      await runStatus();
      return;
    case "unlock":
      await runUnlock(process.argv.slice(3));
      return;
    case "watch":
      await runWatch();
      return;
    case "install-hook":
      await runInstallHook();
      return;
    case "hook": {
      const sub = process.argv[3];
      if (sub === "pre-commit") {
        await runHookPreCommit();
        return;
      }
      console.error(`Unknown hook: ${sub ?? "(none)"}\n\n${usage()}`);
      process.exit(1);
      return;
    }
    case "serve":
    case undefined:
      // serve owns stdout (the MCP protocol channel) — nothing else may write it.
      await startServer();
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${usage()}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("meshlock:", err instanceof Error ? err.message : err);
  process.exit(1);
});


=== src/cli/init.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMeshlock, type StdioServerEntry } from "./init.js";

let tempDir: string;
let configPath: string;

const ENTRY: StdioServerEntry = {
  type: "stdio",
  command: "/usr/bin/node",
  args: ["/abs/dist/cli/index.js", "serve"],
  env: {},
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-init-test-"));
  configPath = join(tempDir, "claude.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function readConfig(path = configPath): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
}

describe("registerMeshlock", () => {
  it("creates a fresh config with the meshlock entry, making parent dirs", async () => {
    const nested = join(tempDir, "a", "b", "claude.json");
    const result = await registerMeshlock(nested, ENTRY);

    expect(result.created).toBe(true);
    expect(result.replaced).toBe(false);
    const cfg = await readConfig(nested);
    expect((cfg.mcpServers as Record<string, unknown>).meshlock).toEqual(ENTRY);
  });

  it("merges without disturbing other servers or top-level keys", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        someTopKey: 42,
        mcpServers: {
          other: { type: "stdio", command: "other", args: [], env: {} },
        },
      }),
      "utf-8"
    );

    const result = await registerMeshlock(configPath, ENTRY);

    expect(result.created).toBe(false);
    expect(result.replaced).toBe(false);
    const cfg = await readConfig();
    const servers = cfg.mcpServers as Record<string, unknown>;
    // Both the pre-existing server and meshlock are present.
    expect(Object.keys(servers).sort()).toEqual(["meshlock", "other"]);
    expect(servers.meshlock).toEqual(ENTRY);
    // Unrelated top-level content is preserved.
    expect(cfg.someTopKey).toBe(42);
  });

  it("is idempotent: a second run replaces, never duplicates", async () => {
    await registerMeshlock(configPath, ENTRY);
    const second = await registerMeshlock(configPath, ENTRY);

    expect(second.replaced).toBe(true);
    const cfg = await readConfig();
    const servers = cfg.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["meshlock"]);
    expect(servers.meshlock).toEqual(ENTRY);
  });

  it("refuses to overwrite an unparseable existing config", async () => {
    const garbage = "{ this is not valid json ";
    await writeFile(configPath, garbage, "utf-8");

    await expect(registerMeshlock(configPath, ENTRY)).rejects.toThrow(
      "not valid JSON"
    );
    // The file is left exactly as it was — we never clobber what we can't parse.
    expect(await readFile(configPath, "utf-8")).toBe(garbage);
  });
});


=== src/cli/init.ts ===
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A stdio MCP server entry, matching the shape Claude Code writes to its config
 * (verified against `claude mcp add` on v2.1.185):
 *   { "type": "stdio", "command": "node", "args": [...], "env": {} }
 */
export interface StdioServerEntry {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Outcome of a registration, for the CLI to report. */
export interface RegisterResult {
  configPath: string;
  /** The config file did not exist and was created. */
  created: boolean;
  /** A previous `meshlock` entry was overwritten (idempotent re-run). */
  replaced: boolean;
}

/**
 * The user-global Claude Code config — the `user` scope target. User-scoped MCP
 * servers live at the TOP-LEVEL `mcpServers` of this file (local scope nests them
 * under projects[cwd]; project scope uses a separate .mcp.json).
 */
export function getClaudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Register (or update) the `meshlock` MCP server in the config at `configPath`,
 * READ-MERGE-WRITE so nothing else is disturbed:
 *  - missing file        -> start from an empty config (created = true)
 *  - existing file       -> parse and preserve ALL existing content
 *  - existing meshlock   -> replaced in place (replaced = true), never duplicated
 *  - unparseable file    -> throw, and DO NOT overwrite (don't destroy a config
 *                           we couldn't understand)
 *
 * @param configPath injected so tests can use a temp file, not the real config.
 */
export async function registerMeshlock(
  configPath: string,
  entry: StdioServerEntry,
  serverName = "meshlock"
): Promise<RegisterResult> {
  let raw: string | null = null;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const created = raw === null;

  let config: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Existing config at ${configPath} is not valid JSON — refusing to ` +
          `overwrite it. Fix or remove the file, then re-run \`meshlock init\`.`
      );
    }
    if (!isPlainObject(parsed)) {
      throw new Error(
        `Existing config at ${configPath} is not a JSON object — refusing to ` +
          `overwrite it.`
      );
    }
    config = parsed;
  }

  const existingServers = config.mcpServers;
  if (existingServers !== undefined && !isPlainObject(existingServers)) {
    throw new Error(
      `"mcpServers" in ${configPath} is not an object — refusing to overwrite it.`
    );
  }
  const servers: Record<string, unknown> = isPlainObject(existingServers)
    ? existingServers
    : {};

  const replaced = Object.prototype.hasOwnProperty.call(servers, serverName);
  servers[serverName] = entry;
  config.mcpServers = servers;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  return { configPath, created, replaced };
}


=== src/cli/status.test.ts ===
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


=== src/cli/status.ts ===
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


=== src/cli/unlock.test.ts ===
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


=== src/cli/unlock.ts ===
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


=== src/core/changes.test.ts ===
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


=== src/core/changes.ts ===
import type { MeshLockDatabase } from "./db.js";

/**
 * One recorded change to a path: the diff a single session produced while it
 * held the lock, plus optional human/agent-facing enrichment. Field names are
 * camelCase here (the TypeScript convention) and are mapped to the snake_case
 * `change_log` columns inside this module — callers never see the SQL names.
 *
 * `diff` is the FLOOR: always present (NOT NULL in the schema), even if it is
 * the empty string for a no-op change. `summary` and `diffStat` are ENRICHMENT:
 * optional, nullable, and MeshLock must read fine without them. The `?` on a
 * field is a compile-time "may be absent" — it erases at runtime, so storage
 * still coalesces a missing value to a real SQL NULL (see recordChange).
 */
export interface ChangeRecord {
  repoRoot: string;
  path: string;
  branch: string | null;
  sessionId: string;
  diff: string;
  summary?: string | null;
  diffStat?: string | null;
  changedAt: string;
}

/** Query shape for {@link getChanges}. `branch` and `limit` are optional. */
export interface ChangeQuery {
  repoRoot: string;
  path: string;
  /**
   * Branch filter. THREE distinct behaviours:
   *  - omitted (undefined): no branch filter — every branch's changes for the path.
   *  - a string: only that branch.
   *  - explicit null: only branchless changes (NULL-means-branchless, as in locks).
   */
  branch?: string | null;
  /** Max rows, most-recent-first. Defaults to 10. */
  limit?: number;
}

/** The raw `change_log` row shape, snake_case, exactly as SQLite returns it. */
interface ChangeRow {
  repo_root: string;
  path: string;
  branch: string | null;
  session_id: string;
  diff: string;
  summary: string | null;
  diff_stat: string | null;
  changed_at: string;
}

/** Default number of recent changes returned by {@link getChanges}. */
const DEFAULT_LIMIT = 10;

/** Map a raw snake_case row to the camelCase {@link ChangeRecord} shape. */
function rowToRecord(row: ChangeRow): ChangeRecord {
  return {
    repoRoot: row.repo_root,
    path: row.path,
    branch: row.branch,
    sessionId: row.session_id,
    diff: row.diff,
    summary: row.summary,
    diffStat: row.diff_stat,
    changedAt: row.changed_at,
  };
}

/**
 * Insert one change record. This is PURE STORAGE — it stores whatever it is
 * given, unconditionally, and decides nothing. Whether a change is even worth
 * recording (e.g. skipping an empty diff) is the caller's policy call in M3.5c,
 * not this module's. Keeping storage "dumb" is what lets the policy evolve
 * without touching the table or this function.
 *
 * The `?? null` coalescing matters: better-sqlite3 rejects a bound `undefined`,
 * and an omitted optional field IS `undefined` at runtime (the `?` is gone after
 * compilation). So a missing summary/diffStat must become an explicit SQL NULL.
 */
export function recordChange(db: MeshLockDatabase, record: ChangeRecord): void {
  db.prepare(
    `INSERT INTO change_log
       (repo_root, path, branch, session_id, diff, summary, diff_stat, changed_at)
     VALUES
       (@repo_root, @path, @branch, @session_id, @diff, @summary, @diff_stat, @changed_at)`
  ).run({
    repo_root: record.repoRoot,
    path: record.path,
    branch: record.branch ?? null,
    session_id: record.sessionId,
    diff: record.diff,
    summary: record.summary ?? null,
    diff_stat: record.diffStat ?? null,
    changed_at: record.changedAt,
  });
}

/**
 * Recent changes for a path, most-recent-first, scoped to one repository.
 *
 * Like every read in this project, the WHERE leads with `repo_root = ?` (S1
 * discipline): forgetting it would leak another repository's change history into
 * a briefing — a silent correctness bug. repo_root is a non-null sentinel, so
 * plain `=` is right; branch (when filtered) uses `IS` for null-safety.
 *
 * Ordering is `changed_at DESC, id DESC`: changed_at gives most-recent-first,
 * and id (the autoincrement surrogate) is a deterministic tiebreaker for two
 * changes recorded in the same millisecond, so the order is stable.
 */
export function getChanges(db: MeshLockDatabase, query: ChangeQuery): ChangeRecord[] {
  const limit = query.limit ?? DEFAULT_LIMIT;

  // Build the branch clause conditionally so an omitted branch means "any".
  if (query.branch === undefined) {
    const rows = db
      .prepare<[string, string, number], ChangeRow>(
        `SELECT repo_root, path, branch, session_id, diff, summary, diff_stat, changed_at
         FROM change_log
         WHERE repo_root = ? AND path = ?
         ORDER BY changed_at DESC, id DESC
         LIMIT ?`
      )
      .all(query.repoRoot, query.path, limit);
    return rows.map(rowToRecord);
  }

  // branch is a string OR explicit null — `IS ?` handles both null-safely.
  const rows = db
    .prepare<[string, string, string | null, number], ChangeRow>(
      `SELECT repo_root, path, branch, session_id, diff, summary, diff_stat, changed_at
       FROM change_log
       WHERE repo_root = ? AND path = ? AND branch IS ?
       ORDER BY changed_at DESC, id DESC
       LIMIT ?`
    )
    .all(query.repoRoot, query.path, query.branch, limit);
  return rows.map(rowToRecord);
}


=== src/core/config.test.ts ===
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";

// Redirect homedir so config.ts writes to a temp dir instead of ~/.meshlock
let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => tempHome,
  };
});

// Import after the mock is in place
const { loadConfig, saveConfig, getConfigPath, getDatabasePath, defaultConfig, ConfigSchema } =
  await import("./config.js");

describe("config", () => {
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "meshlock-test-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("returns default config when no file exists", async () => {
    const config = await loadConfig();
    expect(config.mode).toBe("solo");
    expect(config.lock_timeout).toBe(1800);
    expect(config.lock_mode).toBe("exclusive");
    expect(config.granularity).toBe("file");
    expect(config.cross_branch_mode).toBe("warn");
    expect(config.relay_url).toBeNull();
    expect(config.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("persists the default config on first load — the session_id survives a reload (M6.2)", async () => {
    // No file exists yet: the first load must CREATE it, so identity is
    // stable from first contact instead of a fresh random session_id per run
    // (which made the hook see this machine's own locks as foreign).
    const first = await loadConfig();

    const onDisk = JSON.parse(
      await readFile(getConfigPath(), "utf-8")
    ) as { session_id: string };
    expect(onDisk.session_id).toBe(first.session_id);

    const second = await loadConfig();
    expect(second.session_id).toBe(first.session_id);
  });

  it("saveConfig leaves no .tmp sibling behind after a successful write (M6.2b)", async () => {
    await saveConfig(defaultConfig());

    const dir = join(tempHome, ".meshlock");
    const entries = await readdir(dir);
    expect(entries).toEqual(["config.json"]);
  });

  it("preserves a user-tightened file mode across saves (M6.2b)", async () => {
    await saveConfig(defaultConfig());
    await chmod(getConfigPath(), 0o600);

    await saveConfig(defaultConfig());

    // rename would otherwise install the tmp's fresh umask mode (644).
    const mode = (await stat(getConfigPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writes THROUGH a symlinked config.json instead of replacing the link (M6.2b)", async () => {
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    const realFile = join(dir, "real-config.json");
    await writeFile(realFile, JSON.stringify(defaultConfig()), "utf-8");
    await symlink(realFile, join(dir, "config.json"));

    const saved = defaultConfig();
    await saveConfig(saved);

    // The link survives, and the new content landed in its TARGET.
    expect((await lstat(join(dir, "config.json"))).isSymbolicLink()).toBe(true);
    const target = JSON.parse(await readFile(realFile, "utf-8")) as {
      session_id: string;
    };
    expect(target.session_id).toBe(saved.session_id);
  });

  it("a corrupt-JSON load error names the config path (M6.2b)", async () => {
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), "{ truncated", "utf-8");

    await expect(loadConfig()).rejects.toThrow(getConfigPath());
  });

  it("a corrupt config file still throws and is NEVER overwritten (M6.2)", async () => {
    // Corrupt = user data we can't parse — the refuse-to-clobber rule. Only
    // an ABSENT file may be created.
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    const corrupt = "{ this is not json !!";
    await writeFile(join(dir, "config.json"), corrupt, "utf-8");

    await expect(loadConfig()).rejects.toThrow();
    expect(await readFile(join(dir, "config.json"), "utf-8")).toBe(corrupt);
  });

  it("loads a valid config from disk", async () => {
    const valid = {
      mode: "team",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: "https://relay.example.com",
      lock_timeout: 3600,
      lock_mode: "advisory",
      granularity: "directory",
      cross_branch_mode: "block",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(valid), "utf-8");

    const config = await loadConfig();
    expect(config.mode).toBe("team");
    expect(config.relay_url).toBe("https://relay.example.com");
    expect(config.lock_timeout).toBe(3600);
    expect(config.lock_mode).toBe("advisory");
    expect(config.granularity).toBe("directory");
    expect(config.cross_branch_mode).toBe("block");
  });

  it("throws on invalid mode value", async () => {
    const bad = {
      mode: "multi",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive",
      granularity: "file",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("throws when lock_timeout is below minimum", async () => {
    const bad = {
      mode: "solo",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: null,
      lock_timeout: 30,
      lock_mode: "exclusive",
      granularity: "file",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("throws when lock_timeout exceeds maximum", async () => {
    const bad = {
      mode: "solo",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: null,
      lock_timeout: 9999,
      lock_mode: "exclusive",
      granularity: "file",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("throws on invalid uuid for session_id", async () => {
    const bad = {
      mode: "solo",
      session_id: "not-a-uuid",
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive",
      granularity: "file",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("save then load returns identical data", async () => {
    const original = {
      mode: "team" as const,
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: "https://relay.example.com",
      lock_timeout: 600,
      lock_mode: "advisory" as const,
      granularity: "directory" as const,
      cross_branch_mode: "ignore" as const,
    };

    await saveConfig(original);
    const loaded = await loadConfig();
    expect(loaded).toEqual(original);
  });

  it("saveConfig creates the directory if it does not exist", async () => {
    const config = defaultConfig();
    await saveConfig(config);
    const loaded = await loadConfig();
    expect(loaded.mode).toBe("solo");
  });

  it("saveConfig throws when given invalid config", async () => {
    const bad = {
      mode: "solo" as const,
      session_id: "bad-uuid",
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive" as const,
      granularity: "file" as const,
      cross_branch_mode: "warn" as const,
    };
    await expect(saveConfig(bad)).rejects.toThrow("Cannot save invalid config");
  });

  it("throws on invalid cross_branch_mode value", async () => {
    const bad = {
      mode: "solo",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive",
      granularity: "file",
      cross_branch_mode: "merge",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("getConfigPath includes .meshlock/config.json", () => {
    const path = getConfigPath();
    expect(path).toContain(".meshlock");
    expect(path).toContain("config.json");
  });

  it("defaultConfig generates a fresh uuid each call", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a.session_id).not.toBe(b.session_id);
  });

  it("getDatabasePath ends with meshlock.db in the same dir as getConfigPath", () => {
    expect(getDatabasePath()).toMatch(/meshlock\.db$/);
    expect(dirname(getDatabasePath())).toBe(dirname(getConfigPath()));
  });
});


=== src/core/config.ts ===
import { chmod, readFile, writeFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalizePath } from "./paths.js";

export const ConfigSchema = z.object({
  mode: z.enum(["solo", "team"]),
  session_id: z.string().uuid(),
  relay_url: z.string().url().nullable(),
  lock_timeout: z.number().int().min(60).max(7200),
  lock_mode: z.enum(["exclusive", "advisory"]),
  granularity: z.enum(["file", "directory"]),
  cross_branch_mode: z.enum(["warn", "block", "ignore"]),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The single source of truth for the default cross-branch behaviour. Both the
 * config default below and the lock engine's fallback import this, so the two
 * can never drift apart (they did in M2.5, before this constant existed).
 */
export const DEFAULT_CROSS_BRANCH_MODE = "warn" as const;

export function getConfigPath(): string {
  return join(homedir(), ".meshlock", "config.json");
}

export function getDatabasePath(): string {
  return join(homedir(), ".meshlock", "meshlock.db");
}

export function defaultConfig(): Config {
  return {
    mode: "solo",
    session_id: randomUUID(),
    relay_url: null,
    lock_timeout: 1800,
    lock_mode: "exclusive",
    granularity: "file",
    cross_branch_mode: DEFAULT_CROSS_BRANCH_MODE,
  };
}

export async function loadConfig(): Promise<Config> {
  const path = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const fresh = defaultConfig();
    // ABSENT file = fresh install: persist the default (with its freshly
    // generated session_id) so identity is stable from first contact — a
    // per-run random session_id would make the pre-commit hook see this
    // machine's own MCP-taken locks as foreign and block its commits.
    //
    // CRITICAL: only ENOENT creates. An EXISTING file that merely failed to
    // READ (permissions, I/O) is user data — never write over it (the M3.3b
    // refuse-to-clobber rule; corrupt-but-readable files throw below for the
    // same reason). Non-ENOENT read failures keep the old behaviour: an
    // in-memory default, persisted nowhere.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Best-effort: a failed write (read-only home, quota) must not turn the
      // previously-working absent-file case into a startup crash. Identity is
      // per-run in that pathological case — no worse than pre-M6.2 behaviour.
      try {
        await saveConfig(fresh);
      } catch {
        /* keep the in-memory default */
      }
    }
    return fresh;
  }

  // Parse in a wrap that NAMES the file: a bare SyntaxError ("Unexpected token
  // at position 2") gives the user nothing to act on, and a truncated/corrupt
  // config is exactly the failure a user must locate and delete by hand. Only
  // the message changes — corrupt still throws, file still untouched (M6.2).
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in config at ${path}: ${detail}`);
  }

  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${path}:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }
  return parsed.data;
}

export async function saveConfig(config: Config): Promise<void> {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `Cannot save invalid config:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }

  const path = getConfigPath();
  await mkdir(join(homedir(), ".meshlock"), { recursive: true });

  // Resolve THROUGH a symlinked config.json (dotfile managers) before picking
  // the rename target: renaming onto the link itself would replace the LINK
  // with a regular file and strand its target with stale data — the old
  // writeFile wrote through the link, and that behaviour must survive the
  // atomicity upgrade. For a fresh install canonicalizePath resolves the
  // parent and re-joins the (not-yet-existing) filename.
  const target = canonicalizePath(path);

  // Atomic write: tmp file + rename, so a process killed mid-save leaves the
  // OLD config or the NEW one on disk — never truncated JSON (which would make
  // every future loadConfig throw until hand-deleted). The tmp lives in the
  // SAME DIRECTORY as the target: rename(2) is atomic only within one
  // filesystem, and a /tmp tmpfile could cross a mount and silently degrade to
  // copy+delete. pid + random suffix keeps concurrent savers off each other's
  // tmp files; the last rename wins with a complete file either way.
  const tmpPath = `${target}.${String(process.pid)}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmpPath, JSON.stringify(parsed.data, null, 2), "utf-8");
  // rename installs the TMP file's fresh (umask) mode over the target, where
  // plain writeFile preserved the existing mode — so a user-tightened
  // chmod 600 must be mirrored onto the tmp first. Best-effort: no existing
  // file (fresh install) means nothing to preserve.
  try {
    const existing = await stat(target);
    await chmod(tmpPath, existing.mode & 0o777);
  } catch {
    /* fresh install: default mode applies */
  }
  try {
    await rename(tmpPath, target);
  } catch (err) {
    // Don't leave the orphan behind; the rename failure is the real story.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}


=== src/core/db.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.js";

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-db-test-"));
  dbPath = join(tempDir, "test.db");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("enables WAL journal mode on the connection", () => {
    const db = openDatabase(dbPath);
    try {
      const row = db.pragma("journal_mode", { simple: true });
      expect(row).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("records all migrations in filename order", () => {
    const db = openDatabase(dbPath);
    try {
      const applied = db
        .prepare("SELECT name, applied_at FROM migrations ORDER BY id")
        .all() as { name: string; applied_at: string }[];

      expect(applied.map((m) => m.name)).toEqual([
        "001_create_locks.sql",
        "002_add_branch_to_locks.sql",
        "003_add_repo_root_to_locks.sql",
        "004_drop_repo_root_default.sql",
        "005_change_log.sql",
      ]);
      // Each applied_at should be a parseable ISO timestamp.
      for (const m of applied) {
        expect(Number.isNaN(Date.parse(m.applied_at))).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("creates the locks table with the post-004 schema (repo_root NOT NULL, no default, three-way uniqueness)", () => {
    const db = openDatabase(dbPath);
    try {
      const columns = db
        .prepare("PRAGMA table_info(locks)")
        .all() as { name: string; notnull: number; pk: number; dflt_value: string | null }[];

      const byName = new Map(columns.map((c) => [c.name, c]));
      // `repo_root` (003) and `content_snapshot` (005) join the post-002 columns.
      expect([...byName.keys()].sort()).toEqual([
        "acquired_at",
        "branch",
        "content_snapshot",
        "expires_at",
        "mode",
        "path",
        "repo_root",
        "session_id",
      ]);

      // Identity lives in the UNIQUE(repo_root, path, branch) index, so no column
      // is flagged as a PRIMARY KEY.
      expect(byName.get("path")!.pk).toBe(0);
      // repo_root is a non-null sentinel; branch stays nullable; the rest NOT NULL.
      expect(byName.get("repo_root")!.notnull).toBe(1);
      // 004 removed the S1a DEFAULT '(unknown)', so a missing repo_root now fails
      // loud instead of being silently absorbed into a fake repo.
      expect(byName.get("repo_root")!.dflt_value).toBeNull();
      expect(byName.get("branch")!.notnull).toBe(0);
      expect(byName.get("session_id")!.notnull).toBe(1);
      expect(byName.get("mode")!.notnull).toBe(1);
      expect(byName.get("acquired_at")!.notnull).toBe(1);
      expect(byName.get("expires_at")!.notnull).toBe(1);
      // 005 added content_snapshot as a NULLABLE column with NO default — a
      // missing baseline is legitimate (the inverse of repo_root's non-null
      // identity), so it must not be forced or defaulted.
      expect(byName.get("content_snapshot")!.notnull).toBe(0);
      expect(byName.get("content_snapshot")!.dflt_value).toBeNull();

      // A unique index spanning (repo_root, path, branch) exists.
      const indexes = db.prepare("PRAGMA index_list(locks)").all() as {
        name: string;
        unique: number;
      }[];
      const uniqueCols = indexes
        .filter((i) => i.unique === 1)
        .map((i) =>
          (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map(
            (c) => c.name
          )
        );
      expect(uniqueCols).toContainEqual(["repo_root", "path", "branch"]);
    } finally {
      db.close();
    }
  });

  it("does not re-run migrations when the same DB is opened again", () => {
    const first = openDatabase(dbPath);
    let firstAppliedAt: string;
    try {
      firstAppliedAt = (
        first
          .prepare("SELECT applied_at FROM migrations WHERE name = ?")
          .get("001_create_locks.sql") as { applied_at: string }
      ).applied_at;
    } finally {
      first.close();
    }

    const second = openDatabase(dbPath);
    try {
      const rows = second
        .prepare("SELECT applied_at FROM migrations WHERE name = ?")
        .all("001_create_locks.sql") as { applied_at: string }[];

      // Still exactly one row, with the original timestamp untouched.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.applied_at).toBe(firstAppliedAt);
    } finally {
      second.close();
    }
  });
});


=== src/core/db.ts ===
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

/**
 * A handle to the MeshLock SQLite database. This is just the better-sqlite3
 * `Database` type re-exported under our own name, so other modules
 * (e.g. lock-engine.ts) depend on `MeshLockDatabase` rather than reaching
 * into better-sqlite3 directly.
 */
export type MeshLockDatabase = Database.Database;

/**
 * Directory holding the numbered `.sql` migration files. Resolved relative to
 * this source file so it works whether we run from `src/` (vitest) or the
 * compiled `dist/` tree. Layout: `<repo>/data/migrations`, and this file lives
 * at `<repo>/src/core/db.ts` (or `<repo>/dist/core/db.js`), so we climb two
 * directories to the package root then into `data/migrations`.
 */
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "migrations"
);

/**
 * Open the database at `path`, enable WAL journaling, ensure the migrations
 * bookkeeping table exists, and apply any not-yet-recorded migrations in
 * filename order. Each migration runs inside its own transaction so a failure
 * leaves the database unchanged for that migration. Creates the parent
 * directory if it does not already exist.
 *
 * @param path Filesystem path to the SQLite file. Parameterized so tests can
 *   pass a temp path instead of the real `~/.meshlock` location.
 */
export function openDatabase(path: string): MeshLockDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // WAL = write-ahead logging: better concurrency (readers don't block the
  // writer) and durability characteristics suited to a long-lived daemon.
  db.pragma("journal_mode = WAL");

  ensureMigrationsTable(db);
  runMigrations(db);

  return db;
}

function ensureMigrationsTable(db: MeshLockDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )`
  );
}

function runMigrations(db: MeshLockDatabase): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const isApplied = db.prepare(
    "SELECT 1 FROM migrations WHERE name = ?"
  );
  const recordApplied = db.prepare(
    "INSERT INTO migrations (name, applied_at) VALUES (?, ?)"
  );

  for (const name of files) {
    if (isApplied.get(name)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf-8");

    // One transaction per migration: the schema change and its bookkeeping
    // row commit together, or not at all.
    const apply = db.transaction(() => {
      db.exec(sql);
      recordApplied.run(name, new Date().toISOString());
    });
    apply();
  }
}


=== src/core/diff.test.ts ===
import { describe, it, expect } from "vitest";
import { diffContent } from "./diff.js";

describe("diffContent", () => {
  it("emits a unified diff with the removed and added lines", () => {
    const before = "line one\nline two\nline three\n";
    const after = "line one\nline two CHANGED\nline three\n";

    const diff = diffContent(before, after);

    // The body is what a briefing reads: the - old line and the + new line.
    expect(diff).toContain("-line two\n");
    expect(diff).toContain("+line two CHANGED\n");
    // It is git's format, so it carries the unified-diff hunk header.
    expect(diff).toContain("@@");
  });

  it("returns an empty string for identical inputs (git exit 0)", () => {
    const same = "no change here\n";
    expect(diffContent(same, same)).toBe("");
  });

  it("treats a brand-new file (empty baseline) as all additions", () => {
    // M3.5b will call this with an empty baseline for a freshly created file.
    const diff = diffContent("", "brand new content\n");
    expect(diff).toContain("+brand new content\n");
  });

  it("does not throw when the inputs differ (git exits 1, which is normal)", () => {
    // The whole point of using spawnSync over execFileSync: exit 1 is success.
    expect(() => diffContent("a\n", "b\n")).not.toThrow();
  });
});


=== src/core/diff.ts ===
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Produce a unified diff between two in-memory strings, in git's own format.
 *
 * Why shell out to `git diff --no-index` rather than diff in JS:
 *  - the output is byte-for-byte the format every agent already recognises
 *    (the same thing `git diff` prints), so a briefing reads naturally;
 *  - `--no-index` makes git diff two arbitrary paths with no repository at all,
 *    so this works on content that never touched a repo.
 *
 * git has no "diff two strings" mode — `--no-index` takes two PATHS — so we
 * write the two sides to a scratch temp dir, diff the files, then delete it.
 * The function is synchronous (matching its callers in the lock engine, which
 * is itself synchronous), so every fs/spawn call here is the *Sync variant.
 *
 * EXIT-CODE CONVENTION — the one genuinely surprising thing here:
 * `git diff` exits 0 when the inputs are IDENTICAL and 1 when they DIFFER.
 * For us, "they differ" is the normal, successful case, not an error — so we
 * must NOT treat exit 1 as a failure. We use spawnSync (not execFileSync, which
 * throws on any non-zero exit) precisely so we can inspect the status ourselves:
 *   - status 0  -> identical            -> return "" (no change)
 *   - status 1  -> differences found    -> return the diff on stdout
 *   - anything else (>1, or a spawn error like git-not-found) -> a real fault,
 *     so we throw. A normal diff never throws.
 */
export function diffContent(before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), "meshlock-diff-"));
  try {
    const beforePath = join(dir, "before");
    const afterPath = join(dir, "after");
    writeFileSync(beforePath, before);
    writeFileSync(afterPath, after);

    const result = spawnSync(
      "git",
      ["diff", "--no-index", beforePath, afterPath],
      { encoding: "utf-8" }
    );

    // A spawn-level error (e.g. git is not installed) is a real fault.
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      return "";
    }
    if (result.status === 1) {
      return result.stdout;
    }
    // status > 1, or null (killed by signal): something actually went wrong.
    throw new Error(
      `git diff --no-index exited with status ${String(result.status)}: ${result.stderr}`
    );
  } finally {
    // Always remove the scratch dir, even if git threw.
    rmSync(dir, { recursive: true, force: true });
  }
}


=== src/core/git.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { getCurrentBranch, getRepoRoot, clearBranchCache } from "./git.js";

let tempDir: string;

/**
 * Build a real git repo in `dir` with one commit, then create and check out
 * `branch`. The commit is required: `rev-parse --abbrev-ref HEAD` cannot resolve
 * an unborn branch, so HEAD must point at a real commit first.
 */
async function makeGitRepo(dir: string, branch: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "MeshLock Test");
  await writeFile(join(dir, "README.md"), "test\n", "utf-8");
  await git.add(["README.md"]);
  await git.commit("initial commit");
  await git.checkoutLocalBranch(branch);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-git-test-"));
  // Module-level cache leaks across cases otherwise.
  clearBranchCache();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("getCurrentBranch", () => {
  it("returns the current branch name for a real git repo", async () => {
    await makeGitRepo(tempDir, "feature-x");
    expect(await getCurrentBranch(tempDir)).toBe("feature-x");
  });

  it("returns null for a directory that is not a git repo (no throw)", async () => {
    expect(await getCurrentBranch(tempDir)).toBeNull();
  });

  it("serves the cached value without re-resolving within the TTL", async () => {
    await makeGitRepo(tempDir, "feature-x");
    expect(await getCurrentBranch(tempDir)).toBe("feature-x"); // populates cache

    // Switch the on-disk branch. Within the TTL the cache should still answer
    // with the old value, proving git was not re-run.
    await simpleGit(tempDir).checkoutLocalBranch("switched");
    expect(await getCurrentBranch(tempDir)).toBe("feature-x");
  });

  it("re-resolves after the cache is cleared", async () => {
    await makeGitRepo(tempDir, "feature-x");
    expect(await getCurrentBranch(tempDir)).toBe("feature-x");
    await simpleGit(tempDir).checkoutLocalBranch("switched");

    clearBranchCache();
    expect(await getCurrentBranch(tempDir)).toBe("switched");
  });
});

describe("getRepoRoot", () => {
  it("returns the repository top-level path inside a git repo", async () => {
    await makeGitRepo(tempDir, "feature-x");
    // git --show-toplevel returns the symlink-resolved path, so normalize both
    // sides with realpath (matters on macOS where /tmp -> /private/tmp).
    expect(await getRepoRoot(tempDir)).toBe(await realpath(tempDir));
  });

  it("returns the directory's own realpath (sentinel) when not a git repo", async () => {
    const root = await getRepoRoot(tempDir);
    // realpath-normalized to match git's --show-toplevel (handles /tmp symlinks).
    expect(root).toBe(await realpath(tempDir));
    expect(root).not.toBe(""); // a real path, never null/empty
  });

  it("caches within the TTL and re-resolves after clearBranchCache", async () => {
    await makeGitRepo(tempDir, "feature-x");
    const sub = join(tempDir, "sub");
    await mkdir(sub);

    // From a subdirectory, the repo root is the repo top-level.
    const repoTop = await realpath(tempDir);
    expect(await getRepoRoot(sub)).toBe(repoTop);

    // Deinit the repo; within the TTL the cache still answers with the old root.
    await rm(join(tempDir, ".git"), { recursive: true, force: true });
    expect(await getRepoRoot(sub)).toBe(repoTop);

    // After clearing, it re-resolves to the sentinel (sub's own realpath).
    clearBranchCache();
    expect(await getRepoRoot(sub)).toBe(await realpath(sub));
  });
});


=== src/core/git.ts ===
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { simpleGit } from "simple-git";

/**
 * How long a resolved git fact (branch or repo root) stays cached per working
 * directory. Short enough that a `git checkout` is picked up quickly, long
 * enough that a burst of tool calls spawns at most one `git` subprocess per
 * window.
 */
export const BRANCH_CACHE_TTL_MS = 5000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Keyed by working directory — different cwds can be different repositories, so
// they must not share a cached value. Branch and repo root are cached
// separately: they answer different questions and have different value types
// (branch may be null; repo root is always a string). Module-level, so they
// survive across calls; tests reset both with clearBranchCache().
const branchCache = new Map<string, CacheEntry<string | null>>();
const repoRootCache = new Map<string, CacheEntry<string>>();

/** Drop all cached git resolutions (branch and repo root). Mainly for tests. */
export function clearBranchCache(): void {
  branchCache.clear();
  repoRootCache.clear();
}

/**
 * Resolve the current git branch of the repository containing `cwd` (defaults to
 * the process's working directory — for the daemon, the repo it coordinates).
 *
 * A branch is a property of the whole repository (one HEAD), so we resolve from
 * the repo's working directory, not from any individual file's directory.
 *
 * Returns null when there is no usable branch — not a git repo, detached HEAD,
 * empty output, or any git failure. NEVER throws: git is not a hard requirement,
 * and null is the engine's "branchless" case.
 *
 * Results are cached per cwd for {@link BRANCH_CACHE_TTL_MS} so repeated tool
 * calls don't each spawn a `git` subprocess.
 */
export async function getCurrentBranch(
  cwd: string = process.cwd()
): Promise<string | null> {
  const cached = branchCache.get(cwd);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const value = await resolveBranch(cwd);
  branchCache.set(cwd, { value, expiresAt: Date.now() + BRANCH_CACHE_TTL_MS });
  return value;
}

async function resolveBranch(cwd: string): Promise<string | null> {
  try {
    const branch = (
      await simpleGit(cwd).revparse(["--abbrev-ref", "HEAD"])
    ).trim();
    // "HEAD" means detached; empty means no branch. Both are branchless.
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Resolve the git repository root that `cwd` belongs to (defaults to the
 * process's working directory; callers scoping a file pass that file's
 * directory, since repo membership is a property of where the file lives).
 *
 * Unlike {@link getCurrentBranch}, this returns a non-null SENTINEL: when `cwd`
 * is not inside a git repo (or any git error), it returns `cwd`'s own path,
 * realpath-normalized so it matches git's symlink-resolved --show-toplevel (e.g.
 * macOS /tmp -> /private/tmp). A non-git file's "repo root" is just its own
 * directory. This keeps repo_root out of the NULL-uniqueness trap — it is always
 * a real string, so a UNIQUE(repo_root, ...) constraint behaves normally. NEVER
 * throws.
 *
 * Cached per cwd for {@link BRANCH_CACHE_TTL_MS}, like branch resolution.
 */
export async function getRepoRoot(cwd: string = process.cwd()): Promise<string> {
  const cached = repoRootCache.get(cwd);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const value = await resolveRepoRoot(cwd);
  repoRootCache.set(cwd, { value, expiresAt: Date.now() + BRANCH_CACHE_TTL_MS });
  return value;
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const root = (
      await simpleGit(cwd).revparse(["--show-toplevel"])
    ).trim();
    if (root !== "") return root;
  } catch {
    // Not a git repo (or git unavailable): fall through to the sentinel.
  }
  // Sentinel: the directory's own path, realpath-normalized to match git's
  // symlink-resolved output. realpath throws if the path doesn't exist, so fall
  // back to resolve() to keep the never-throws contract.
  try {
    return await realpath(cwd);
  } catch {
    return resolve(cwd);
  }
}


=== src/core/lock-engine.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "./db.js";
import {
  acquireLock,
  releaseLock,
  checkLock,
  forceReleaseLock,
  listLocks,
  expireStaleLocks,
} from "./lock-engine.js";

let tempDir: string;
let dbPath: string;
let db: MeshLockDatabase;

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

// A single shared repo for the non-isolation tests: adding repo_root to every
// call must not change the branch/conflict behavior proven in M2/M2.5.
const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-lock-test-"));
  dbPath = join(tempDir, "test.db");
  db = openDatabase(dbPath);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

/** Seed a row directly, bypassing acquireLock — useful for past-expiry rows. */
function seedLock(
  conn: MeshLockDatabase,
  path: string,
  sessionId: string,
  expiresAt: string,
  acquiredAt = "2000-01-01T00:00:00.000Z",
  mode = "exclusive",
  repoRoot = REPO_A,
  branch: string | null = null
): void {
  conn
    .prepare(
      `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(repoRoot, path, sessionId, mode, acquiredAt, expiresAt, branch);
}

function rowCount(conn: MeshLockDatabase, path?: string): number {
  if (path === undefined) {
    return (conn.prepare("SELECT COUNT(*) AS n FROM locks").get() as { n: number }).n;
  }
  return (
    conn.prepare("SELECT COUNT(*) AS n FROM locks WHERE path = ?").get(path) as {
      n: number;
    }
  ).n;
}

describe("acquireLock — conflict", () => {
  it("returns a held conflict when another live session owns the path", () => {
    const a = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });

    expect(b).toEqual({ ok: false, reason: "held", heldBy: SESSION_A });

    // Exactly one row, still owned by A.
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
    const owner = (
      db.prepare("SELECT session_id FROM locks WHERE path = ?").get("/repo/file.ts") as {
        session_id: string;
      }
    ).session_id;
    expect(owner).toBe(SESSION_A);
  });
});

describe("acquireLock — same-session re-acquire", () => {
  it("refreshes the lock and advances expires_at without adding a row", () => {
    const first = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 60,
    });
    expect(first.ok).toBe(true);
    const firstExpiry = first.ok ? first.lock.expires_at : "";

    const second = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 3600,
    });
    expect(second.ok).toBe(true);
    const secondExpiry = second.ok ? second.lock.expires_at : "";

    // Longer timeout => later expiry. ISO-8601 strings compare chronologically.
    expect(secondExpiry > firstExpiry).toBe(true);
    expect(rowCount(db)).toBe(1);
  });
});

describe("acquireLock — content snapshot (M3.5b)", () => {
  const path = "/repo/snap.ts";

  /** Read the stored snapshot for a path straight from the row. */
  function snapshotOf(p: string): string | null {
    return (
      db.prepare("SELECT content_snapshot FROM locks WHERE path = ?").get(p) as {
        content_snapshot: string | null;
      }
    ).content_snapshot;
  }

  it("stores the snapshot passed on an initial acquire", () => {
    const r = acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      contentSnapshot: "ORIGINAL CONTENT",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.content_snapshot).toBe("ORIGINAL CONTENT");
    expect(snapshotOf(path)).toBe("ORIGINAL CONTENT");
  });

  it("preserves the ORIGINAL snapshot across a same-session refresh (keystone)", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 60,
      contentSnapshot: "A",
    });
    // Same session re-acquires (a refresh) with DIFFERENT content. The baseline
    // must NOT move to "B" — it stays the content from the first acquire, so the
    // release-time diff is measured from the true starting point.
    const refresh = acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 3600,
      contentSnapshot: "B",
    });
    expect(refresh.ok).toBe(true);
    if (refresh.ok) expect(refresh.lock.content_snapshot).toBe("A");
    // Still exactly one row (the test-B invariant), still the original baseline.
    expect(rowCount(db, path)).toBe(1);
    expect(snapshotOf(path)).toBe("A");
  });

  it("stores null when no snapshot is provided and does not throw", () => {
    const r = acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.content_snapshot).toBeNull();
    expect(snapshotOf(path)).toBeNull();
  });

  it("captures the new holder's snapshot when taking over an EXPIRED lock (not a refresh)", () => {
    // A's lock is already expired (seeded with no snapshot). B acquiring is a
    // takeover, NOT a same-session refresh, so B's incoming baseline is stored.
    seedLock(db, path, SESSION_A, "2000-01-01T00:00:01.000Z");
    const r = acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      contentSnapshot: "NEW HOLDER",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.content_snapshot).toBe("NEW HOLDER");
    expect(snapshotOf(path)).toBe("NEW HOLDER");
  });
});

describe("releaseLock — ownership", () => {
  it("only the owning session can release; others are a no-op", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });

    // B does not own it: nothing removed, nothing returned.
    expect(
      releaseLock(db, { repoRoot: REPO_A, path: "/repo/file.ts", sessionId: SESSION_B })
    ).toEqual([]);
    expect(rowCount(db, "/repo/file.ts")).toBe(1);

    // A owns it: removed, and the deleted row comes back.
    const deleted = releaseLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.session_id).toBe(SESSION_A);
    expect(checkLock(db, REPO_A, "/repo/file.ts").held).toBe(false);
  });

  it("releasing a path with no lock is a no-op returning []", () => {
    expect(releaseLock(db, { repoRoot: REPO_A, path: "/nope", sessionId: SESSION_A })).toEqual(
      []
    );
  });
});

describe("releaseLock — returns deleted rows (M5.1c)", () => {
  const path = "/repo/released.ts";

  it("returns the deleted row with its branch and baseline snapshot", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
      contentSnapshot: "BASELINE",
    });

    const deleted = releaseLock(db, { repoRoot: REPO_A, path, sessionId: SESSION_A });

    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.branch).toBe("main");
    expect(deleted[0]!.content_snapshot).toBe("BASELINE");
    expect(rowCount(db, path)).toBe(0);
  });

  it("returns ALL of the session's per-branch rows and leaves foreign rows", () => {
    for (const branch of ["main", "feature"]) {
      acquireLock(db, {
        repoRoot: REPO_A,
        path,
        sessionId: SESSION_A,
        mode: "exclusive",
        timeoutSeconds: 1800,
        branch,
        contentSnapshot: `base-${branch}`,
        crossBranchMode: "ignore",
      });
    }
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "theirs",
      crossBranchMode: "ignore",
    });

    const deleted = releaseLock(db, { repoRoot: REPO_A, path, sessionId: SESSION_A });

    // Both of A's branch rows, each with its own baseline; B's row survives.
    expect(deleted.map((l) => l.branch)).toEqual(["feature", "main"]); // ORDER BY branch
    expect(deleted.map((l) => l.content_snapshot)).toEqual(["base-feature", "base-main"]);
    expect(deleted.every((l) => l.session_id === SESSION_A)).toBe(true);
    expect(rowCount(db, path)).toBe(1);
  });

  it("returns an EXPIRED-but-owned row (the caller can still diff its baseline)", () => {
    seedLock(db, path, SESSION_A, "2000-01-01T00:30:00.000Z");

    const deleted = releaseLock(db, { repoRoot: REPO_A, path, sessionId: SESSION_A });

    expect(deleted).toHaveLength(1);
    expect(rowCount(db, path)).toBe(0);
  });
});

describe("TTL expiry", () => {
  it("an expired lock reports free and does not block a fresh acquire", () => {
    // Seed an already-expired lock owned by A.
    seedLock(db, "/repo/file.ts", SESSION_A, "2000-01-01T00:00:01.000Z");

    expect(checkLock(db, REPO_A, "/repo/file.ts").held).toBe(false);

    const fresh = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.lock.session_id).toBe(SESSION_B);
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
  });
});

describe("checkLock", () => {
  it("reports a live lock as held with its details", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "advisory",
      timeoutSeconds: 1800,
    });
    const result = checkLock(db, REPO_A, "/repo/live.ts");
    expect(result.held).toBe(true);
    if (result.held) {
      expect(result.lock.session_id).toBe(SESSION_A);
      expect(result.lock.mode).toBe("advisory");
    }
  });

  it("reports an unknown path as free", () => {
    expect(checkLock(db, REPO_A, "/unknown").held).toBe(false);
  });
});

describe("checkLock — branch filter (M5.1b)", () => {
  const path = "/repo/multi-branch.ts";
  const SESSION_C = "33333333-3333-4333-8333-333333333333";

  /** Seed three COEXISTING live locks on one path: main (A), feature (B), branchless (C). */
  function seedThreeBranches(): void {
    for (const [sessionId, branch] of [
      [SESSION_A, "main"],
      [SESSION_B, "feature"],
      [SESSION_C, null],
    ] as const) {
      const r = acquireLock(db, {
        repoRoot: REPO_A,
        path,
        sessionId,
        mode: "exclusive",
        timeoutSeconds: 1800,
        branch,
        crossBranchMode: "ignore",
      });
      expect(r.ok).toBe(true);
    }
    expect(rowCount(db, path)).toBe(3);
  }

  it("returns exactly the requested branch's row when branches coexist", () => {
    seedThreeBranches();

    const main = checkLock(db, REPO_A, path, "main");
    expect(main.held).toBe(true);
    if (main.held) {
      expect(main.lock.branch).toBe("main");
      expect(main.lock.session_id).toBe(SESSION_A);
    }

    const feature = checkLock(db, REPO_A, path, "feature");
    expect(feature.held).toBe(true);
    if (feature.held) {
      expect(feature.lock.branch).toBe("feature");
      expect(feature.lock.session_id).toBe(SESSION_B);
    }
  });

  it("explicit null matches ONLY the branchless row (IS, not =)", () => {
    seedThreeBranches();

    const r = checkLock(db, REPO_A, path, null);
    expect(r.held).toBe(true);
    if (r.held) {
      expect(r.lock.branch).toBeNull();
      expect(r.lock.session_id).toBe(SESSION_C);
    }
  });

  it("reports free for a branch with no lock even while other branches hold one", () => {
    // Only a 'feature' lock exists — neither "main" nor branchless may match it.
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
    });

    expect(checkLock(db, REPO_A, path, "main").held).toBe(false);
    expect(checkLock(db, REPO_A, path, null).held).toBe(false);
  });

  it("omitted branch still returns SOME live row (any-branch behaviour pinned)", () => {
    seedThreeBranches();

    const r = checkLock(db, REPO_A, path);
    expect(r.held).toBe(true);
    if (r.held) expect(r.lock.path).toBe(path);
  });

  it("omitted branch skips an EXPIRED row and reports the LIVE sibling (M5.1c)", () => {
    // Expired 'feature' seeded FIRST — before M5.1c the unconstrained .get()
    // picked it by scan order and reported free despite the live 'main' lock.
    seedLock(
      db,
      path,
      SESSION_B,
      "2000-01-01T00:30:00.000Z",
      "2000-01-01T00:00:00.000Z",
      "exclusive",
      REPO_A,
      "feature"
    );
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
      crossBranchMode: "ignore",
    });

    const r = checkLock(db, REPO_A, path);
    expect(r.held).toBe(true);
    if (r.held) expect(r.lock.branch).toBe("main");
  });
});

describe("listLocks", () => {
  it("returns only non-expired locks, ordered by path", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/live-b.ts",
      sessionId: SESSION_B,
      mode: "advisory",
      timeoutSeconds: 1800,
    });
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/live-a.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    seedLock(db, "/repo/dead.ts", SESSION_A, "2000-01-01T00:30:00.000Z");

    const live = listLocks(db, REPO_A);
    expect(live.map((l) => l.path)).toEqual(["/repo/live-a.ts", "/repo/live-b.ts"]);
  });
});

describe("expireStaleLocks", () => {
  it("deletes only expired rows and returns how many were removed", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    seedLock(db, "/repo/dead-1.ts", SESSION_A, "2000-01-01T00:30:00.000Z");
    seedLock(db, "/repo/dead-2.ts", SESSION_B, "2000-01-01T00:30:00.000Z");

    expect(expireStaleLocks(db)).toBe(2);

    const remaining = listLocks(db, REPO_A).map((l) => l.path);
    expect(remaining).toEqual(["/repo/live.ts"]);
    expect(rowCount(db)).toBe(1);
  });

  it("returns 0 when nothing is expired", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/live.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    expect(expireStaleLocks(db)).toBe(0);
    expect(rowCount(db)).toBe(1);
  });
});

describe("acquireLock — branch dimension", () => {
  it("same branch, different session → still hard-blocks", () => {
    const a = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(b).toEqual({ ok: false, reason: "held", heldBy: SESSION_A });
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
  });

  it("cross-branch with crossBranchMode 'warn' → succeeds AND carries a warning", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
      crossBranchMode: "warn",
    });

    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.warning).toEqual({
        reason: "cross_branch",
        otherBranch: "main",
        heldBy: SESSION_A,
      });
    }
    // Both locks coexist: one per branch.
    expect(rowCount(db, "/repo/file.ts")).toBe(2);
  });

  it("cross-branch with crossBranchMode 'block' → hard conflict", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
      crossBranchMode: "block",
    });

    expect(b).toEqual({ ok: false, reason: "held", heldBy: SESSION_A });
    // B never wrote its row.
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
  });

  it("cross-branch with crossBranchMode 'ignore' → succeeds, no warning", () => {
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const b = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
      crossBranchMode: "ignore",
    });

    expect(b.ok).toBe(true);
    if (b.ok) expect(b.warning).toBeUndefined();
    expect(rowCount(db, "/repo/file.ts")).toBe(2);
  });

  it("two branchless (null) locks on the same path, different sessions → still block", () => {
    // This is the crucial one: UNIQUE(repo_root, path, branch) will NOT stop two
    // (path, NULL) rows because SQL treats NULL != NULL. The block here is
    // enforced by the engine's selectSame check, not by the database constraint.
    const a = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });
    expect(a.ok).toBe(true);

    const b = acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/file.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });
    expect(b).toEqual({ ok: false, reason: "held", heldBy: SESSION_A });
    // Proof the constraint did not silently allow a second branchless row.
    expect(rowCount(db, "/repo/file.ts")).toBe(1);
  });
});

describe("acquireLock — repo isolation", () => {
  it("same path and branch in different repos do not conflict", () => {
    const a = acquireLock(db, {
      repoRoot: REPO_A,
      path: "src/index.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(a.ok).toBe(true);

    // Same path, same branch, DIFFERENT repo, different session → must succeed.
    const b = acquireLock(db, {
      repoRoot: REPO_B,
      path: "src/index.ts",
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    expect(b.ok).toBe(true);

    // Both rows coexist — repo_root genuinely isolates them.
    expect(rowCount(db, "src/index.ts")).toBe(2);

    // checkLock is repo-scoped: each repo sees only its own holder.
    const ca = checkLock(db, REPO_A, "src/index.ts");
    const cb = checkLock(db, REPO_B, "src/index.ts");
    expect(ca.held).toBe(true);
    if (ca.held) expect(ca.lock.session_id).toBe(SESSION_A);
    expect(cb.held).toBe(true);
    if (cb.held) expect(cb.lock.session_id).toBe(SESSION_B);

    // listLocks is repo-scoped: repo A does not see repo B's lock and vice versa.
    expect(listLocks(db, REPO_A).map((l) => l.repo_root)).toEqual([REPO_A]);
    expect(listLocks(db, REPO_B).map((l) => l.repo_root)).toEqual([REPO_B]);
  });
});

describe("concurrency — two connections to the same DB file", () => {
  it("contends at BEGIN IMMEDIATE: while one holds the write lock the other cannot begin", () => {
    // Two independent connections to the same file.
    const connA = openDatabase(dbPath);
    const connB = openDatabase(dbPath);
    // busy_timeout = 0 => the loser of the write-lock race fails immediately
    // instead of waiting, which lets us observe the contention deterministically.
    connB.pragma("busy_timeout = 0");

    try {
      // connA opens an IMMEDIATE transaction and holds the RESERVED write lock.
      connA.exec("BEGIN IMMEDIATE");
      connA
        .prepare(
          `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          REPO_A,
          "/repo/contended.ts",
          SESSION_A,
          "exclusive",
          new Date().toISOString(),
          new Date(Date.now() + 1800 * 1000).toISOString()
        );

      // While A holds the write lock, B's acquireLock cannot even BEGIN IMMEDIATE.
      let code: string | undefined;
      try {
        acquireLock(connB, {
          repoRoot: REPO_A,
          path: "/repo/contended.ts",
          sessionId: SESSION_B,
          mode: "exclusive",
          timeoutSeconds: 1800,
        });
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      // Proof the connections genuinely serialize through the write lock.
      expect(code).toBe("SQLITE_BUSY");

      connA.exec("COMMIT");
    } finally {
      if (connA.inTransaction) connA.exec("ROLLBACK");
      connA.close();
      connB.close();
    }
  });

  it("produces exactly one winner and one held conflict across two connections", () => {
    const connA = openDatabase(dbPath);
    const connB = openDatabase(dbPath);
    connA.pragma("busy_timeout = 2000");
    connB.pragma("busy_timeout = 2000");

    try {
      const path = "/repo/contended.ts";

      // Two real acquireLock calls from two real connections to the same file.
      // Because better-sqlite3 is synchronous these resolve in order, but each
      // runs its own BEGIN IMMEDIATE against the shared file: the first commits,
      // the second's transaction then reads the committed row and reports held.
      const r1 = acquireLock(connA, {
        repoRoot: REPO_A,
        path,
        sessionId: SESSION_A,
        mode: "exclusive",
        timeoutSeconds: 1800,
      });
      const r2 = acquireLock(connB, {
        repoRoot: REPO_A,
        path,
        sessionId: SESSION_B,
        mode: "exclusive",
        timeoutSeconds: 1800,
      });

      const winners = [r1, r2].filter((r) => r.ok);
      const conflicts = [r1, r2].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(conflicts).toHaveLength(1);

      // The conflict names the winner as the holder.
      const conflict = conflicts[0]!;
      const winner = winners[0]!;
      if (!conflict.ok && winner.ok) {
        expect(conflict.heldBy).toBe(winner.lock.session_id);
      }

      // Exactly one row survives, owned by the winner.
      expect(rowCount(connA, path)).toBe(1);
    } finally {
      connA.close();
      connB.close();
    }
  });
});

describe("forceReleaseLock (M6.2c)", () => {
  const path = "/repo/forced.ts";

  it("deletes ALL sessions' rows on the path across branches, returned branch-ordered", () => {
    // Three claims on one path: two sessions, three branches (incl. branchless).
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
      crossBranchMode: "ignore",
    });
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
      crossBranchMode: "ignore",
    });
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
      crossBranchMode: "ignore",
    });

    const deleted = forceReleaseLock(db, REPO_A, path);

    // No ownership filter: every session's row went. SQLite ASC: NULL first.
    expect(deleted.map((l) => l.branch)).toEqual([null, "feature", "main"]);
    expect(rowCount(db, path)).toBe(0);
  });

  it("leaves other paths and other repos untouched (S1)", () => {
    const samePathOtherRepo = path;
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    acquireLock(db, {
      repoRoot: REPO_A,
      path: "/repo/bystander.ts",
      sessionId: SESSION_A,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    acquireLock(db, {
      repoRoot: REPO_B,
      path: samePathOtherRepo,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });

    const deleted = forceReleaseLock(db, REPO_A, path);

    expect(deleted).toHaveLength(1);
    // The bystander path and the same path string in REPO_B both survive.
    expect(rowCount(db, "/repo/bystander.ts")).toBe(1);
    expect(checkLock(db, REPO_B, samePathOtherRepo).held).toBe(true);
  });

  it("returns [] when the path has no locks", () => {
    expect(forceReleaseLock(db, REPO_A, "/repo/nothing-here.ts")).toEqual([]);
  });

  it("returns and deletes EXPIRED rows too (sweeping the path clean)", () => {
    seedLock(db, path, SESSION_A, "2000-01-01T00:30:00.000Z"); // long expired
    acquireLock(db, {
      repoRoot: REPO_A,
      path,
      sessionId: SESSION_B,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
      crossBranchMode: "ignore",
    });

    const deleted = forceReleaseLock(db, REPO_A, path);

    expect(deleted).toHaveLength(2);
    const sessions = deleted.map((l) => l.session_id).sort();
    expect(sessions).toEqual([SESSION_A, SESSION_B]);
    expect(rowCount(db, path)).toBe(0);
  });
});


=== src/core/lock-engine.ts ===
import type { MeshLockDatabase } from "./db.js";
import { DEFAULT_CROSS_BRANCH_MODE } from "./config.js";

/**
 * Lock mode — the same vocabulary as config.ts `lock_mode` and the `mode`
 * column in 001_create_locks.sql.
 */
export type LockMode = "exclusive" | "advisory";

/**
 * How to treat a path that is locked by another session on a *different* branch.
 * Same vocabulary as config.ts `cross_branch_mode`. The engine never reads
 * config itself — the caller passes the chosen mode in, the same dependency-
 * injection discipline used for the DB handle.
 */
export type CrossBranchMode = "warn" | "block" | "ignore";

/**
 * One row of the `locks` table. Field names mirror the migration columns
 * exactly so the shape can be read straight out of better-sqlite3. `repo_root`
 * scopes the lock to one repository (a non-null sentinel — see core/git.ts).
 * `branch` is nullable: NULL means "no branch / not a git repo", and the engine
 * treats two NULL branches as the same logical branch. Lock identity is the
 * triple (repo_root, path, branch).
 */
export interface Lock {
  repo_root: string;
  path: string;
  session_id: string;
  mode: LockMode;
  acquired_at: string;
  expires_at: string;
  branch: string | null;
  /**
   * Baseline file content captured when this session FIRST took the lock
   * (M3.5b), or null if the file was absent/unreadable at that moment. M3.5c
   * diffs the release-time content against this to report what changed. The
   * column (005) is nullable with no default — a missing baseline is legitimate.
   * Preserved across same-session refreshes; dies with the lock on release.
   */
  content_snapshot: string | null;
}

/** Input to {@link acquireLock}. */
export interface AcquireInput {
  /**
   * Repository the lock belongs to. REQUIRED (no default): forgetting it is a
   * compile error, which is the type-level guard against cross-repo leaks.
   */
  repoRoot: string;
  path: string;
  sessionId: string;
  mode: LockMode;
  timeoutSeconds: number;
  /** Git branch the lock belongs to. Omit or pass null for "no branch". */
  branch?: string | null;
  /** How to handle a cross-branch conflict. Defaults to DEFAULT_CROSS_BRANCH_MODE. */
  crossBranchMode?: CrossBranchMode;
  /**
   * Baseline file content to store at acquire (M3.5b). The TOOL reads the file
   * and injects it here — the engine never touches the filesystem. Optional: a
   * missing/unreadable file is captured as null. IGNORED on a same-session
   * refresh, where the engine preserves the snapshot already on the row so the
   * baseline stays the content from when the session first took the lock.
   */
  contentSnapshot?: string | null;
}

/**
 * Attached to a successful {@link AcquireResult} when the path is also locked by
 * another session on a different branch and `crossBranchMode` was "warn". The
 * acquire still succeeded; this is advisory information for the caller to relay.
 */
export interface CrossBranchWarning {
  reason: "cross_branch";
  /** The other holder's branch. May be null if that lock is branchless. */
  otherBranch: string | null;
  heldBy: string;
}

/**
 * Result of {@link acquireLock}. A discriminated union on `ok`: the conflict
 * case ("someone else holds it") is an expected outcome, returned as data
 * rather than thrown. Throwing is reserved for programmer errors and DB faults.
 * The success variant may carry a `warning` (cross-branch "warn" mode).
 */
export type AcquireResult =
  | { ok: true; lock: Lock; warning?: CrossBranchWarning }
  | { ok: false; reason: "held"; heldBy: string };

/** Input to {@link releaseLock}. */
export interface ReleaseInput {
  repoRoot: string;
  path: string;
  sessionId: string;
}

/** Result of {@link checkLock}: either the current holder, or free. */
export type CheckResult =
  | { held: true; lock: Lock }
  | { held: false };

/** ISO-8601 "now", matching how the migration documents acquired_at/expires_at. */
function nowIso(): string {
  return new Date().toISOString();
}

/** ISO-8601 timestamp `seconds` in the future. */
function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Acquire (or refresh) the lock on `path` for `sessionId`.
 *
 * The check-and-set runs inside a BEGIN IMMEDIATE transaction. IMMEDIATE is
 * required — not the deferred default — because we read the current holder and
 * then conditionally write based on what we read. A deferred transaction takes
 * only a SHARED read lock at BEGIN and upgrades to RESERVED at the first write,
 * which leaves a window where two connections both pass the read, both try to
 * upgrade, and one fails with SQLITE_BUSY mid-decision. IMMEDIATE takes the
 * RESERVED write lock up front, so connections serialize at BEGIN and exactly
 * one performs the whole read-then-write atomically; the other blocks (up to
 * busy_timeout) and then sees the now-committed row.
 */
export function acquireLock(
  db: MeshLockDatabase,
  input: AcquireInput
): AcquireResult {
  const { repoRoot, path, sessionId, mode, timeoutSeconds } = input;
  const branch = input.branch ?? null;
  const crossBranchMode = input.crossBranchMode ?? DEFAULT_CROSS_BRANCH_MODE;

  // Every statement is scoped by repo_root FIRST: a lock's identity is the
  // triple (repo_root, path, branch). repo_root is a non-null sentinel, so plain
  // `=` is correct; branch keeps `IS` for null-safety.
  //
  // `branch IS ?` is null-safe equality: with a NULL bind it becomes `branch IS
  // NULL`, with a string it behaves like `=`. This is why two branchless locks
  // count as the same logical branch even though SQL `=` would never match NULL.
  const selectSame = db.prepare<[string, string, string | null], Lock>(
    "SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot FROM locks WHERE repo_root = ? AND path = ? AND branch IS ?"
  );
  // The mirror: `branch IS NOT ?` is null-safe inequality — a different branch,
  // treating NULL as distinct from any name. Still scoped to this repo.
  const selectCross = db.prepare<[string, string, string | null, string, string], Lock>(
    `SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot FROM locks
     WHERE repo_root = ? AND path = ? AND branch IS NOT ? AND session_id != ? AND expires_at > ?
     ORDER BY branch`
  );
  const deleteSame = db.prepare(
    "DELETE FROM locks WHERE repo_root = ? AND path = ? AND branch IS ?"
  );
  const insert = db.prepare(
    `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot)
     VALUES (@repo_root, @path, @session_id, @mode, @acquired_at, @expires_at, @branch, @content_snapshot)`
  );

  const txn = db.transaction((): AcquireResult => {
    const now = nowIso();

    // Same-branch conflict: a live lock on our (repo_root, path, branch) held by
    // another session is a hard block — unchanged M2 behavior, now repo-scoped.
    const same = selectSame.get(repoRoot, path, branch);
    if (same && same.expires_at > now && same.session_id !== sessionId) {
      return { ok: false, reason: "held", heldBy: same.session_id };
    }

    // Cross-branch: the same path in the same repo locked by another session on
    // a different branch. The query already filters to live, other-session,
    // other-branch rows; take the first (ordered by branch for determinism).
    let warning: CrossBranchWarning | undefined;
    const otherBranchLock = selectCross.get(repoRoot, path, branch, sessionId, now);
    if (otherBranchLock) {
      if (crossBranchMode === "block") {
        return { ok: false, reason: "held", heldBy: otherBranchLock.session_id };
      }
      if (crossBranchMode === "warn") {
        warning = {
          reason: "cross_branch",
          otherBranch: otherBranchLock.branch,
          heldBy: otherBranchLock.session_id,
        };
      }
      // "ignore": proceed silently.
    }

    // Snapshot capture (M3.5b). On the INITIAL acquire we store the baseline the
    // caller injected. On a same-session REFRESH we PRESERVE the snapshot already
    // on the row and discard the incoming value, so the baseline stays the content
    // from when this session first took the lock — re-snapshotting on a renewal
    // would reset the baseline to a mid-edit state and under-report the diff.
    //
    // `same` here is the (repo, path, branch) row regardless of session. If it
    // belongs to this session it is a refresh; a different-session `same` was
    // either a live block (returned above) or an expired takeover (below), and a
    // takeover should capture the NEW holder's baseline, not the dead lock's.
    let snapshotToStore: string | null;
    if (same !== undefined && same.session_id === sessionId) {
      snapshotToStore = same.content_snapshot;
    } else {
      snapshotToStore = input.contentSnapshot ?? null;
    }

    // Write our lock. DELETE-then-INSERT rather than ON CONFLICT: the
    // UNIQUE(repo_root, path, branch) index does NOT fire for NULL branches (SQL
    // treats NULLs as distinct), so an upsert would silently insert a duplicate
    // branchless row. Deleting the same (repo, path, branch) row first guarantees
    // exactly one such row whether we are creating, refreshing, or replacing an
    // expired lock — and it never touches other branches' or other repos' rows.
    const lock: Lock = {
      repo_root: repoRoot,
      path,
      session_id: sessionId,
      mode,
      acquired_at: now,
      expires_at: futureIso(timeoutSeconds),
      branch,
      content_snapshot: snapshotToStore,
    };
    deleteSame.run(repoRoot, path, branch);
    insert.run(lock);
    return warning ? { ok: true, lock, warning } : { ok: true, lock };
  });

  // .immediate() runs the transaction body under BEGIN IMMEDIATE.
  return txn.immediate();
}

/**
 * Release the lock on `path` in `repoRoot`, but only if `sessionId` is the
 * holder. Releasing a lock you don't own (or one that doesn't exist) is a no-op,
 * not an error. Branch-agnostic (no branch filter) but repo-scoped, so it drops
 * all of the session's locks on that path within the one repo.
 *
 * Returns the row(s) it deleted (M5.1c); `[]` means nothing was released. Each
 * returned row carries its branch and its acquire-time content_snapshot, so the
 * caller can diff/record per branch AFTER the lock is gone — including for an
 * EXPIRED-but-owned row (the M3.5c lost-record gap: the old boolean forced the
 * caller to re-read the row via checkLock, which reports expired rows as free).
 * Ownership scoping also means a caller can only ever see rows it owned.
 *
 * SELECT-then-DELETE runs under BEGIN IMMEDIATE for the same reason as
 * acquireLock: the two statements must observe the same rows, with no window
 * for another connection to change them in between.
 *
 * @returns the deleted rows, ordered by branch for determinism.
 */
export function releaseLock(db: MeshLockDatabase, input: ReleaseInput): Lock[] {
  const select = db.prepare<[string, string, string], Lock>(
    `SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot FROM locks
     WHERE repo_root = ? AND path = ? AND session_id = ?
     ORDER BY branch`
  );
  const del = db.prepare(
    "DELETE FROM locks WHERE repo_root = ? AND path = ? AND session_id = ?"
  );

  const txn = db.transaction((): Lock[] => {
    const rows = select.all(input.repoRoot, input.path, input.sessionId);
    if (rows.length > 0) {
      del.run(input.repoRoot, input.path, input.sessionId);
    }
    return rows;
  });
  return txn.immediate();
}

/**
 * Release EVERY session's locks on `path` in `repoRoot` — {@link releaseLock}
 * WITHOUT the ownership filter. This is the HUMAN override primitive (CLI
 * `unlock --force`): a person deliberately breaking another session's claim.
 * Agents keep the ownership-scoped releaseLock; nothing in the MCP surface
 * calls this.
 *
 * Same SELECT-then-DELETE causality as releaseLock, in one BEGIN IMMEDIATE
 * transaction: the returned rows are exactly what was deleted — live AND
 * expired alike (a human sweeping a path clean wants the stale rows gone
 * too). `[]` means there was nothing to remove. Branch-ordered for stable
 * output (SQLite ASC: NULL first).
 */
export function forceReleaseLock(
  db: MeshLockDatabase,
  repoRoot: string,
  path: string
): Lock[] {
  const select = db.prepare<[string, string], Lock>(
    `SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot FROM locks
     WHERE repo_root = ? AND path = ?
     ORDER BY branch`
  );
  const del = db.prepare("DELETE FROM locks WHERE repo_root = ? AND path = ?");

  const txn = db.transaction((): Lock[] => {
    const rows = select.all(repoRoot, path);
    if (rows.length > 0) {
      del.run(repoRoot, path);
    }
    return rows;
  });
  return txn.immediate();
}

/**
 * Report the current holder of `path` within `repoRoot`. A lock whose
 * expires_at <= now counts as free.
 *
 * `branch` follows the SAME three-way convention as changes.ts getChanges —
 * the two per-path lookups stay deliberately symmetric:
 *  - omitted (undefined): no branch filter — the historical any-branch lookup.
 *    With coexisting per-branch locks (UNIQUE permits one live row per branch)
 *    the returned row is ARBITRARY among LIVE rows (M5.1c put liveness in the
 *    WHERE); fine for "is anything holding this path?" consumers (daemon
 *    classify, the check_lock tool), wrong for any per-branch decision — those
 *    must pass `branch`.
 *  - a string: only that branch's lock.
 *  - explicit null: only a branchless lock (NULL-means-branchless, as in the
 *    (repo_root, path, branch) lock identity).
 * The filter is `branch IS ?`, never `=` — SQL three-valued logic makes
 * `= NULL` match nothing (the M2.5 rule, same as every branch comparison here).
 */
export function checkLock(
  db: MeshLockDatabase,
  repoRoot: string,
  path: string,
  branch?: string | null
): CheckResult {
  const now = nowIso();
  // Omitted path: liveness must live IN the WHERE (M5.1c). With several
  // per-branch rows, an unconstrained .get() could pick an EXPIRED row and
  // report free while a LIVE sibling exists on another branch. The FILTERED
  // path below has at most one candidate per branch, so its post-fetch expiry
  // check is equivalent — left as-is. The post-fetch check stays for both
  // paths as the belt.
  const row =
    branch === undefined
      ? db
          .prepare<[string, string, string], Lock>(
            "SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot FROM locks WHERE repo_root = ? AND path = ? AND expires_at > ?"
          )
          .get(repoRoot, path, now)
      : db
          .prepare<[string, string, string | null], Lock>(
            "SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot FROM locks WHERE repo_root = ? AND path = ? AND branch IS ?"
          )
          .get(repoRoot, path, branch);

  if (!row || row.expires_at <= now) {
    return { held: false };
  }
  return { held: true, lock: row };
}

/** Return all currently-held (non-expired) locks within `repoRoot`. */
export function listLocks(db: MeshLockDatabase, repoRoot: string): Lock[] {
  const now = nowIso();
  return db
    .prepare<[string, string], Lock>(
      "SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot FROM locks WHERE repo_root = ? AND expires_at > ? ORDER BY path"
    )
    .all(repoRoot, now);
}

/**
 * Delete every lock whose expires_at <= now. Called explicitly by a caller
 * (e.g. on a sweep); it does not schedule itself.
 *
 * This is the ONE function that stays repo-agnostic: reaping dead rows is pure
 * housekeeping, and an expired lock is garbage no matter which repo it belonged
 * to, so there is no cross-repo-leak risk in deleting them all.
 *
 * @returns the number of stale rows removed.
 */
export function expireStaleLocks(db: MeshLockDatabase): number {
  const result = db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(nowIso());
  return result.changes;
}


=== src/core/paths.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizePath } from "./paths.js";

let tempDir: string;
let realDir: string; // canonical form of tempDir/real
let linkDir: string; // tempDir/alias -> tempDir/real

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-paths-test-"));
  await mkdir(join(tempDir, "real"));
  await symlink(join(tempDir, "real"), join(tempDir, "alias"));
  // realpath() the base too: the OS tmp dir itself may be a symlink (macOS
  // /tmp -> /private/tmp), and expected values must be fully canonical.
  realDir = await realpath(join(tempDir, "real"));
  linkDir = join(tempDir, "alias");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("canonicalizePath", () => {
  it("resolves an existing file reached through a symlinked directory", async () => {
    await writeFile(join(realDir, "file.ts"), "content\n");

    const canonical = canonicalizePath(join(linkDir, "file.ts"));

    expect(canonical).toBe(join(realDir, "file.ts"));
  });

  it("resolves a MISSING file under a symlinked directory via its parent", () => {
    // The file does not exist (about to be created) — tier 2: the parent's
    // realpath fixes the aliased prefix, the basename rides along.
    const canonical = canonicalizePath(join(linkDir, "ghost.ts"));

    expect(canonical).toBe(join(realDir, "ghost.ts"));
  });

  it("falls back to resolve() for a fully missing path and never throws", () => {
    const missing = "/no/such/dir/anywhere/file.ts";

    expect(() => canonicalizePath(missing)).not.toThrow();
    expect(canonicalizePath(missing)).toBe(resolve(missing));
  });

  it("canonicalizes a missing MULTI-LEVEL suffix under a symlinked prefix (M6.2 walk-up)", () => {
    // Neither newdir nor newfile.ts exists — the M6.1 sliver: single-level
    // parent resolution fell to lexical resolve() here and kept the alias.
    // The walk-up finds the deepest existing ancestor (the aliased dir),
    // canonicalizes it, and re-joins the whole missing remainder.
    const canonical = canonicalizePath(join(linkDir, "newdir", "newfile.ts"));

    expect(canonical).toBe(join(realDir, "newdir", "newfile.ts"));
  });
});


=== src/core/paths.ts ===
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Symlink-canonical absolute form of an agent-supplied path.
 *
 * WHY entry-point normalization: lock identity is the stored path STRING, and
 * comparisons happen all over — the engine's lookups, the pre-commit hook, the
 * daemon's classify, the change-briefing queries. Canonicalizing one side of
 * any of those comparisons is unsound (a lock acquired via /tmp/alias/f.ts is
 * invisible to a hook checking /tmp/real/f.ts — the M5.2 under-enforcement
 * hole). Normalizing ONCE, where a path ENTERS MeshLock, means every consumer
 * downstream inherits correctness without knowing symlinks exist.
 *
 * Strategy, never throws (the getRepoRoot sentinel spirit):
 *  1. Path exists → realpathSync(path): the OS's own canonical answer.
 *  2. Path missing (locking a file about to be CREATED is legitimate — M3.5b,
 *     and the missing suffix may be several levels deep, e.g. a new directory
 *     plus a new file) → WALK UP via dirname() to the deepest EXISTING
 *     ancestor, canonicalize that, and re-join the missing remainder. The
 *     symlinked-prefix variance lives in the existing directories, so this
 *     fixes the alias problem however deep the not-yet-created suffix is.
 *     Terminates because dirname() strictly shortens toward the fs root,
 *     which always realpaths.
 *  3. If even the walk finds no realpath-able ancestor (pathological — e.g.
 *     realpath failing for non-ENOENT reasons all the way up) → resolve(path):
 *     plain lexical absolutization keeps the never-throws contract.
 */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    let ancestor = dirname(path);
    let remainder = basename(path);
    for (;;) {
      try {
        return join(realpathSync(ancestor), remainder);
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          // Reached the fs root without one successful realpath.
          return resolve(path);
        }
        remainder = join(basename(ancestor), remainder);
        ancestor = parent;
      }
    }
  }
}


=== src/daemon/classify.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { classifyEvent } from "./classify.js";
import type { WatchEvent } from "./watcher.js";

let tempDir: string;
let db: MeshLockDatabase;

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";
const SESSION = "88888888-8888-4888-8888-888888888888";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-classify-test-"));
  db = openDatabase(join(tempDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

/** A normalized watcher event, synthetic — no chokidar involved. */
function event(path: string, type: WatchEvent["type"] = "change"): WatchEvent {
  return { type, path, at: "2026-07-06T12:00:00.000Z" };
}

/** Seed a live lock through the real engine. */
function seedLive(repoRoot: string, path: string, branch: string | null = null): void {
  acquireLock(db, {
    repoRoot,
    path,
    sessionId: SESSION,
    mode: "exclusive",
    timeoutSeconds: 1800,
    branch,
    crossBranchMode: "ignore",
  });
}

/** Seed an already-expired lock directly (acquireLock can't create the past). */
function seedExpired(repoRoot: string, path: string, branch: string | null = null): void {
  db.prepare(
    `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    repoRoot,
    path,
    SESSION,
    "exclusive",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:30:00.000Z",
    branch
  );
}

describe("classifyEvent", () => {
  it("returns guarded with the lock row for a change on a live-locked path", () => {
    const path = "/repos/alpha/src/db.ts";
    seedLive(REPO_A, path);

    const verdict = classifyEvent(db, REPO_A, event(path));

    expect(verdict.kind).toBe("guarded");
    if (verdict.kind === "guarded") {
      expect(verdict.lock.session_id).toBe(SESSION);
      expect(verdict.event.path).toBe(path);
    }
  });

  it("returns unguarded for a change on an unlocked path", () => {
    const verdict = classifyEvent(db, REPO_A, event("/repos/alpha/free.ts"));
    expect(verdict).toEqual({
      kind: "unguarded",
      event: event("/repos/alpha/free.ts"),
    });
  });

  it("returns unguarded when the path's lock is EXPIRED", () => {
    const path = "/repos/alpha/stale.ts";
    seedExpired(REPO_A, path);

    const verdict = classifyEvent(db, REPO_A, event(path));

    // An expired lock guards nothing — checkLock treats it as free.
    expect(verdict.kind).toBe("unguarded");
  });

  it("returns guarded when an EXPIRED lock coexists with a LIVE lock on another branch (M5.1c)", () => {
    const path = "/repos/alpha/mixed.ts";
    // Expired 'feature' seeded FIRST: before M5.1c the any-branch lookup could
    // pick this row, report free, and raise a false UNGUARDED despite the live
    // 'main' lock.
    seedExpired(REPO_A, path, "feature");
    seedLive(REPO_A, path, "main");

    const verdict = classifyEvent(db, REPO_A, event(path));

    expect(verdict.kind).toBe("guarded");
    if (verdict.kind === "guarded") expect(verdict.lock.branch).toBe("main");
  });

  it("returns unguarded when the same path string is locked only in a DIFFERENT repo", () => {
    const path = "src/index.ts";
    seedLive(REPO_B, path); // live lock, wrong repo

    const verdict = classifyEvent(db, REPO_A, event(path));

    // S1 isolation: repo A's daemon must not see repo B's lock as protection.
    expect(verdict.kind).toBe("unguarded");
  });

  it("preserves the event type through a guarded verdict (unlink under lock)", () => {
    const path = "/repos/alpha/deleted.ts";
    seedLive(REPO_A, path);

    const verdict = classifyEvent(db, REPO_A, event(path, "unlink"));

    expect(verdict.kind).toBe("guarded");
    if (verdict.kind === "guarded") {
      // M4.3 policy needs to see it was a DELETE under lock, not a mere change.
      expect(verdict.event.type).toBe("unlink");
      expect(verdict.lock.session_id).toBe(SESSION);
    }
  });
});


=== src/daemon/classify.ts ===
import type { MeshLockDatabase } from "../core/db.js";
import { checkLock, type Lock } from "../core/lock-engine.js";
import type { WatchEvent } from "./watcher.js";

/**
 * The daemon's judgment on one filesystem event — a discriminated union on
 * `kind`, same pattern as the engine's AcquireResult. Both variants carry the
 * full WatchEvent through, so M4.3 policy can distinguish e.g. a delete-under-
 * lock from a change-under-lock without reclassifying; "guarded" additionally
 * carries the live lock row (holder, mode, branch, expiry) for the policy to
 * act on.
 *
 * KNOWN LIMITS (documented, not solved here):
 *  - Attribution: a live lock on the path does NOT prove the lock's holder made
 *    this edit. OS file events carry no session identity, so "guarded" means
 *    "someone holds a lock", not "the holder did this". Full attribution is
 *    parked with the M8 identity question.
 *  - Branch: checkLock is path-level within the repo, so "guarded" means the
 *    path is locked on SOME branch — not necessarily the branch the working
 *    tree currently has checked out.
 */
export type Verdict =
  | { kind: "guarded"; event: WatchEvent; lock: Lock }
  | { kind: "unguarded"; event: WatchEvent };

/**
 * Classify one watcher event against the locks table: a LIVE lock on the
 * event's path (in the injected repo) ⇒ guarded; anything else — no lock, or an
 * expired one (checkLock already treats expired as free) ⇒ unguarded, the flag
 * the daemon exists to raise.
 *
 * Pure and synchronous by design: no git calls, no fs reads, no config —
 * `repoRoot` is injected (the daemon resolves it once at startup, M4.3), and
 * the only I/O is the checkLock lookup. All three event types classify by the
 * same rule; what to DO about each is M4.3 policy, not classification.
 */
export function classifyEvent(
  db: MeshLockDatabase,
  repoRoot: string,
  event: WatchEvent
): Verdict {
  const result = checkLock(db, repoRoot, event.path);
  return result.held
    ? { kind: "guarded", event, lock: result.lock }
    : { kind: "unguarded", event };
}


=== src/daemon/index.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { DEFAULT_DEBOUNCE_MS } from "./watcher.js";
import { startDaemon, type DaemonHandle } from "./index.js";

// Two SEPARATE temp dirs: the watched tree and the DB's home. The DB must live
// OUTSIDE the watched tree, or every SQLite/WAL write would itself fire watch
// events — the self-feeding loop the .meshlock default-ignore exists to prevent.
let watchDir: string;
let dbDir: string;
let db: MeshLockDatabase;
let lines: string[];
let handle: DaemonHandle | undefined;

const SESSION = "99999999-9999-4999-8999-999999999999";

beforeEach(async () => {
  watchDir = await mkdtemp(join(tmpdir(), "meshlock-daemon-watch-"));
  dbDir = await mkdtemp(join(tmpdir(), "meshlock-daemon-db-"));
  db = openDatabase(join(dbDir, "test.db"));
  lines = [];
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  db.close();
  await rm(watchDir, { recursive: true, force: true });
  await rm(dbDir, { recursive: true, force: true });
});

/** Start the daemon over watchDir, collecting sink lines; awaits readiness. */
async function start(): Promise<void> {
  handle = startDaemon({ db, repoRoot: watchDir, sink: (l) => lines.push(l) });
  await handle.ready;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

describe("startDaemon", () => {
  it("emits exactly one UNGUARDED line for a write to an unlocked path", async () => {
    await start();

    const path = join(watchDir, "unlocked.ts");
    await writeFile(path, "nobody holds me\n");
    await waitFor(() => lines.length >= 1);
    await sleep(DEFAULT_DEBOUNCE_MS * 3); // stragglers would betray a double-fire

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("UNGUARDED");
    expect(lines[0]).toContain("add");
    expect(lines[0]).toContain(path);
  });

  it("stays silent for a write to a live-locked path", async () => {
    const locked = join(watchDir, "locked.ts");
    await writeFile(locked, "v1\n"); // exists pre-start: the edit is a change
    acquireLock(db, {
      repoRoot: watchDir,
      path: locked,
      sessionId: SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    await start();

    await writeFile(locked, "v2\n");
    // Control: an unlocked write must produce a line — proving the pipeline is
    // alive, so silence about `locked` means "guarded", not "daemon broken".
    const control = join(watchDir, "control.ts");
    await writeFile(control, "flag me\n");
    await waitFor(() => lines.length >= 1);
    await sleep(DEFAULT_DEBOUNCE_MS * 3);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(control);
    expect(lines.some((l) => l.includes(locked))).toBe(false);
  });

  it("surfaces a watcher error as one line and keeps running", async () => {
    // Unreadable subdir → EACCES during chokidar's initial scan (see
    // watcher.test.ts — verified deterministic against the installed chokidar).
    const noperm = join(watchDir, "noperm");
    await mkdir(noperm);
    await chmod(noperm, 0o000);

    try {
      await start();
      await waitFor(() => lines.some((l) => l.includes("watcher error")));

      // Still running: an unguarded write still gets flagged.
      const alive = join(watchDir, "alive.ts");
      await writeFile(alive, "post-error\n");
      await waitFor(() => lines.some((l) => l.includes(alive)));
    } finally {
      await chmod(noperm, 0o755); // let afterEach's rm traverse it
    }
  });

  it("emits nothing after close()", async () => {
    await start();
    await handle!.close();

    await writeFile(join(watchDir, "late.ts"), "after close\n");
    await sleep(DEFAULT_DEBOUNCE_MS * 4);

    expect(lines).toHaveLength(0);
  });
});


=== src/daemon/index.ts ===
import type { MeshLockDatabase } from "../core/db.js";
import { classifyEvent } from "./classify.js";
import { createWatcher } from "./watcher.js";

/**
 * Everything the daemon needs, injected (the engine's DI discipline): no
 * config reads, no path resolution, no globals in here. The CLI layer (which
 * owns process concerns) assembles these once at startup.
 */
export interface DaemonDeps {
  db: MeshLockDatabase;
  /** The repo this daemon guards — resolved ONCE by the caller. */
  repoRoot: string;
  /**
   * Where warning lines go, one call per line (no trailing newline). Default
   * writes to stderr — stdout stays clean by project discipline. Injectable so
   * tests collect lines in an array instead of capturing real stderr.
   */
  sink?: (line: string) => void;
}

/** Handle returned by {@link startDaemon}. */
export interface DaemonHandle {
  /** Resolves when the underlying watcher's initial scan is done. */
  ready: Promise<void>;
  /** Stop watching. Does NOT close the DB or the process — the caller owns those. */
  close(): Promise<void>;
}

/**
 * Compose watcher → classify → policy into a running detector.
 *
 * Policy (M4.3):
 *  - unguarded event → ONE warning line: the flag this daemon exists to raise.
 *  - guarded event   → silence. It is the expected steady state, and logging
 *    it would bury the unguarded signal in noise.
 *  - watcher error   → one line, keep running. A transient fs hiccup must not
 *    kill a long-running detector.
 *
 * No process.exit and no signal handling in here — the factory runs anywhere
 * (tests included); process lifecycle belongs to the CLI layer.
 */
export function startDaemon(deps: DaemonDeps): DaemonHandle {
  const sink =
    deps.sink ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });

  const watcher = createWatcher(
    deps.repoRoot,
    (event) => {
      const verdict = classifyEvent(deps.db, deps.repoRoot, event);
      if (verdict.kind === "unguarded") {
        sink(
          `[meshlock] UNGUARDED ${event.type} ${event.at} ${event.path} (no live lock)`
        );
      }
      // guarded: deliberately silent.
    },
    {
      onError: (err) => {
        const detail = err instanceof Error ? err.message : String(err);
        sink(`[meshlock] watcher error: ${detail} — still watching`);
      },
    }
  );

  return {
    ready: watcher.ready,
    close: (): Promise<void> => watcher.close(),
  };
}


=== src/daemon/watcher.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWatcher,
  DEFAULT_DEBOUNCE_MS,
  type WatchEvent,
  type WatcherHandle,
} from "./watcher.js";

let tempDir: string;
let events: WatchEvent[];
let handle: WatcherHandle | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-watcher-test-"));
  events = [];
});

afterEach(async () => {
  // Always tear the watcher down BEFORE deleting its root — a leaked watcher
  // keeps the suite's event loop alive (open-handle warning).
  await handle?.close();
  handle = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

/** Start watching tempDir, collecting events; resolves when chokidar is ready. */
async function start(ignore?: string[]): Promise<void> {
  handle = createWatcher(tempDir, (e) => events.push(e), { ignore });
  await handle.ready;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, failing loudly on timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

/** Wait for at least one event, then a quiet period to let any stragglers land. */
async function settle(): Promise<void> {
  await waitFor(() => events.length >= 1);
  await sleep(DEFAULT_DEBOUNCE_MS * 3);
}

describe("createWatcher", () => {
  it("fires exactly one normalized change event for a single write", async () => {
    const file = join(tempDir, "watched.ts");
    await writeFile(file, "before\n"); // exists pre-start: no add replay
    await start();

    await writeFile(file, "after\n");
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("change");
    expect(events[0]!.path).toBe(file);
    // `at` is a real ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(events[0]!.at))).toBe(false);
  });

  it("coalesces a burst of rapid writes to one path into a single event", async () => {
    const file = join(tempDir, "bursty.ts");
    await writeFile(file, "v0\n");
    await start();

    // Back-to-back sync writes — the shape of an editor save burst. Every raw
    // event restarts the debounce timer, so only ONE event may emerge.
    for (let i = 1; i <= 5; i++) {
      writeFileSync(file, `v${String(i)}\n`);
    }
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("change");
    expect(events[0]!.path).toBe(file);
  });

  it("fires add for a new file and unlink for a deleted one", async () => {
    const existing = join(tempDir, "doomed.ts");
    await writeFile(existing, "bye\n");
    await start();

    const created = join(tempDir, "fresh.ts");
    await writeFile(created, "hi\n");
    await waitFor(() => events.some((e) => e.type === "add"));

    await rm(existing);
    await waitFor(() => events.some((e) => e.type === "unlink"));
    await sleep(DEFAULT_DEBOUNCE_MS * 3);

    expect(events).toHaveLength(2);
    expect(events.find((e) => e.type === "add")!.path).toBe(created);
    expect(events.find((e) => e.type === "unlink")!.path).toBe(existing);
  });

  it("stays silent for writes under ignored directories", async () => {
    await mkdir(join(tempDir, ".git"));
    await mkdir(join(tempDir, "node_modules"));
    await start();

    await writeFile(join(tempDir, ".git", "HEAD"), "ref: nowhere\n");
    await writeFile(join(tempDir, "node_modules", "pkg.js"), "module\n");
    // Control write: proves the watcher is alive, so "no ignored events" means
    // "ignored", not "watcher broken".
    const control = join(tempDir, "control.ts");
    await writeFile(control, "seen\n");
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe(control);
  });

  it("emits nothing after close()", async () => {
    const file = join(tempDir, "late.ts");
    await writeFile(file, "before\n");
    await start();

    await handle!.close();
    await writeFile(file, "after\n");
    await sleep(DEFAULT_DEBOUNCE_MS * 4);

    expect(events).toHaveLength(0);
  });

  it("delivers chokidar errors to an injected onError", async () => {
    // An unreadable subdir makes chokidar's initial scan hit EACCES — a real,
    // deterministic error (verified against the installed chokidar).
    const noperm = join(tempDir, "noperm");
    await mkdir(noperm);
    await chmod(noperm, 0o000);

    const errors: unknown[] = [];
    try {
      handle = createWatcher(tempDir, (e) => events.push(e), {
        onError: (err) => errors.push(err),
      });
      await handle.ready;
      await waitFor(() => errors.length >= 1);

      expect(errors.length).toBeGreaterThanOrEqual(1);
      // The watch itself survived the error: a normal write still lands.
      const control = join(tempDir, "alive.ts");
      await writeFile(control, "still watching\n");
      await waitFor(() => events.some((e) => e.path === control));
    } finally {
      // Restore perms so afterEach's rm can traverse the dir.
      await chmod(noperm, 0o755);
    }
  });

  it("cancels an add followed by unlink inside one window (transient temp file)", async () => {
    await start();

    // Create and delete back-to-back — well inside one debounce window.
    const transient = join(tempDir, "transient.tmp");
    writeFileSync(transient, "here and gone\n");
    rmSync(transient);
    // Control write proves the watcher is alive, so "no transient event"
    // means "cancelled", not "watcher broken".
    const control = join(tempDir, "control.ts");
    await writeFile(control, "seen\n");
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe(control);
  });
});


=== src/daemon/watcher.ts ===
import { watch } from "chokidar";

/**
 * The three filesystem happenings MeshLock cares about. Directory events and
 * chokidar's richer vocabulary are deliberately not surfaced — the daemon
 * reasons about files.
 */
export type WatchEventType = "add" | "change" | "unlink";

/**
 * One normalized filesystem event. `path` is absolute (chokidar echoes the
 * absolute root it was given); `at` is ISO-8601 UTC, the same timestamp format
 * as every other MeshLock record.
 */
export interface WatchEvent {
  type: WatchEventType;
  path: string;
  at: string;
}

/** Callback invoked once per debounced event. */
export type OnWatchEvent = (event: WatchEvent) => void;

export interface WatcherOptions {
  /** Debounce window in ms — events on one path within it coalesce. Default 100. */
  debounceMs?: number;
  /**
   * Path SEGMENTS to ignore (a file is ignored if any segment of its path
   * matches an entry exactly). REPLACES the defaults when given.
   */
  ignore?: string[];
  /**
   * Called when chokidar reports an error (vanished file mid-scan, permission
   * refusal, …). The watch itself keeps running. Default: absorb silently —
   * the M4.1 behaviour, so existing callers are unaffected; the daemon (M4.3)
   * injects its own to surface one line per error.
   */
  onError?: (err: unknown) => void;
}

/** Handle returned by {@link createWatcher}. */
export interface WatcherHandle {
  /** Resolves once chokidar's initial scan is done and events are trustworthy. */
  ready: Promise<void>;
  /** Stop watching: cancels pending (unemitted) debounced events, then closes. */
  close(): Promise<void>;
}

// 200, not 100: chokidar's atomic mode delays cross-process unlink delivery by
// ~100ms (its atomic-save detection), so a touch-then-rm transient straddled a
// 100ms window and emitted add+unlink instead of cancelling (observed live in
// M4.3's e2e). 200ms re-captures the pair so the add→unlink cancel fires.
export const DEFAULT_DEBOUNCE_MS = 200;

/**
 * Segment names ignored by default: VCS internals, dependency trees, and the
 * MeshLock data dir (~/.meshlock) — watching our own SQLite/WAL writes would
 * make the daemon feed on its own output. Matched by segment NAME so the
 * watcher stays config-free (it never resolves the actual DB path).
 */
export const DEFAULT_IGNORE = [".git", "node_modules", ".meshlock"];

/**
 * Wrap chokidar into a debounced, normalized event source. Pure sensor: it
 * knows files, not locks — no DB, no config, no MeshLock domain logic. Root and
 * callback are injected (the engine's DI discipline), so tests point it at a
 * temp dir and collect events in an array.
 *
 * Debounce: editors and tools write in bursts (write + truncate + metadata,
 * or several saves in quick succession). Each raw chokidar event for a path
 * (re)starts that path's timer; only when a path has been quiet for
 * `debounceMs` does ONE normalized event fire. Timers are per-path, so a busy
 * file never suppresses events for a different file. Within one window the
 * LAST event type wins, with one refinement: add followed by change is still
 * an "add" (the file is new to observers; the trailing change is part of its
 * creation burst).
 */
export function createWatcher(
  root: string,
  onEvent: OnWatchEvent,
  options: WatcherOptions = {}
): WatcherHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ignore = options.ignore ?? DEFAULT_IGNORE;

  // Split on both separators so a Windows path can't smuggle a segment past
  // the check on a platform where path.sep is "/".
  const isIgnored = (p: string): boolean =>
    p.split(/[\\/]/).some((segment) => ignore.includes(segment));

  const pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; type: WatchEventType }
  >();
  let closed = false;

  const watcher = watch(root, {
    ignored: isIgnored,
    // Files that exist at startup are state, not events — do not replay them.
    ignoreInitial: true,
  });

  // Without a listener a chokidar "error" (e.g. a file vanishing mid-scan, a
  // permission hiccup) would throw as an unhandled EventEmitter error and kill
  // the process. The watcher has no logging policy of its own — the caller
  // decides via onError; the default absorbs silently. Either way the watch
  // itself keeps running.
  const onError = options.onError ?? ((): void => {});
  watcher.on("error", onError);

  const schedule = (type: WatchEventType, path: string): void => {
    if (closed) return;
    const prev = pending.get(path);
    let effective = type;
    if (prev) {
      clearTimeout(prev.timer);
      // add followed by unlink inside one window is a transient temp file:
      // observers never saw it exist, so the pair CANCELS to nothing (M4.3
      // fix — a bare "unlink" here would false-flag a delete-under-lock for
      // a file that never meaningfully existed).
      if (prev.type === "add" && type === "unlink") {
        pending.delete(path);
        return;
      }
      if (prev.type === "add" && type === "change") effective = "add";
    }
    const timer = setTimeout(() => {
      pending.delete(path);
      onEvent({ type: effective, path, at: new Date().toISOString() });
    }, debounceMs);
    pending.set(path, { timer, type: effective });
  };

  watcher.on("add", (path) => schedule("add", path));
  watcher.on("change", (path) => schedule("change", path));
  watcher.on("unlink", (path) => schedule("unlink", path));

  const ready = new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve());
  });

  return {
    ready,
    async close(): Promise<void> {
      closed = true;
      // Pending events are dropped, not flushed: after close() the caller must
      // hear nothing, and a half-observed burst is not worth reporting.
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      await watcher.close();
    },
  };
}


=== src/hooks/install.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_MARKER, installHook } from "./install.js";

let repoDir: string;
let hookPath: string;

beforeEach(async () => {
  // installHook only needs the .git directory shape — no real git required.
  repoDir = await mkdtemp(join(tmpdir(), "meshlock-install-"));
  await mkdir(join(repoDir, ".git", "hooks"), { recursive: true });
  hookPath = join(repoDir, ".git", "hooks", "pre-commit");
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("installHook", () => {
  it("writes the shim: shebang, marker, PATH-relative exec line, mode 0755", async () => {
    const result = installHook(repoDir);

    expect(result.installed).toBe(true);
    if (result.installed) {
      expect(result.hookPath).toBe(hookPath);
      expect(result.replaced).toBe(false);
    }

    const content = await readFile(hookPath, "utf-8");
    expect(content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(content).toContain(HOOK_MARKER);
    // PATH-relative `meshlock`, not an absolute node/dist path (M3.3b lesson).
    expect(content).toContain('exec meshlock hook pre-commit "$@"');

    const mode = (await stat(hookPath)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("REFUSES to overwrite a foreign pre-commit hook and leaves it intact", async () => {
    const foreign = "#!/bin/sh\nexec someone-elses-linter\n";
    await writeFile(hookPath, foreign);

    const result = installHook(repoDir);

    expect(result.installed).toBe(false);
    if (!result.installed) {
      expect(result.reason).toContain("refusing to overwrite");
    }
    // Untouched, byte for byte.
    expect(await readFile(hookPath, "utf-8")).toBe(foreign);
  });

  it("is idempotent over its own marker (upgrade path overwrites)", async () => {
    expect(installHook(repoDir).installed).toBe(true);

    const second = installHook(repoDir);
    expect(second.installed).toBe(true);
    if (second.installed) expect(second.replaced).toBe(true);

    const content = await readFile(hookPath, "utf-8");
    expect(content).toContain(HOOK_MARKER);
    expect((await stat(hookPath)).mode & 0o777).toBe(0o755);
  });

  it("accepts the git dir itself (anything holding HEAD) as the target", async () => {
    await writeFile(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const result = installHook(join(repoDir, ".git"));

    expect(result.installed).toBe(true);
    expect(await readFile(hookPath, "utf-8")).toContain(HOOK_MARKER);
  });

  it("refuses a directory that is not a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "meshlock-nogit-"));
    try {
      const result = installHook(plain);
      expect(result.installed).toBe(false);
      if (!result.installed) {
        expect(result.reason).toContain("not a git repository");
      }
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});


=== src/hooks/install.ts ===
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The ownership marker. Its presence in an existing pre-commit hook is the ONLY
 * thing that authorizes overwriting it (idempotent upgrade); its absence means
 * the hook is someone else's enforcement and we refuse to clobber it — the same
 * refuse-to-clobber discipline as M3.3b's unparseable-config rule. Versioned so
 * a future incompatible shim can detect and migrate old installs.
 */
export const HOOK_MARKER = "# meshlock-hook v1";

/**
 * The shim itself. `meshlock` is PATH-relative, NOT an absolute node/dist path —
 * the M3.3b lesson: a pinned path like ~/.nvm/versions/v22.x/... dies on the
 * next nvm upgrade and silently UN-ENFORCES every commit. PATH survives
 * upgrades, and its failure mode (meshlock not on PATH) is rare and loud:
 * git prints "meshlock: command not found" on every commit until fixed.
 */
const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER} — managed by meshlock; reinstall with \`meshlock install-hook\`.
exec meshlock hook pre-commit "$@"
`;

/** Discriminated on `installed`, like the engine's result unions. */
export type InstallHookResult =
  | { installed: true; hookPath: string; replaced: boolean }
  | { installed: false; hookPath: string | null; reason: string };

/**
 * `target` may be a repo ROOT (containing `.git/`) or a git dir itself
 * (`…/.git`, or a bare repo — anything holding HEAD). Returns null when it is
 * neither. A `.git` FILE (worktree/submodule pointer) is not followed in v1.
 */
function resolveGitDir(target: string): string | null {
  const dotGit = join(target, ".git");
  if (existsSync(dotGit) && statSync(dotGit).isDirectory()) {
    return dotGit;
  }
  if (existsSync(join(target, "HEAD"))) {
    return target;
  }
  return null;
}

/**
 * Install (or idempotently upgrade) the meshlock pre-commit shim into the
 * repo's `.git/hooks/pre-commit`, mode 0755.
 *
 * Never throws for the expected refusals (not a repo, foreign hook) — those
 * come back as `{ installed: false, reason }` for the CLI to print. chmod runs
 * unconditionally after the write because writeFileSync's `mode` only applies
 * when CREATING a file; an upgrade overwrite would otherwise keep whatever
 * mode the old file had.
 */
export function installHook(target: string): InstallHookResult {
  const gitDir = resolveGitDir(target);
  if (gitDir === null) {
    return {
      installed: false,
      hookPath: null,
      reason: `${target} is not a git repository (no .git directory found)`,
    };
  }

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  let existing: string | null = null;
  try {
    existing = readFileSync(hookPath, "utf-8");
  } catch {
    // No existing hook — the clean-install path.
  }

  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    return {
      installed: false,
      hookPath,
      reason:
        `refusing to overwrite the existing pre-commit hook at ${hookPath}: ` +
        `it has no "${HOOK_MARKER}" marker, so it is someone else's enforcement. ` +
        "Move or chain it manually, then re-run `meshlock install-hook`.",
    };
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, HOOK_SCRIPT);
  chmodSync(hookPath, 0o755);
  return { installed: true, hookPath, replaced: existing !== null };
}


=== src/hooks/pre-commit.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { checkCommit } from "./pre-commit.js";

let tempDir: string;
let db: MeshLockDatabase;

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/beta";
const MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-precommit-test-"));
  db = openDatabase(join(tempDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

/** Seed a live lock through the real engine. */
function seedLive(
  repoRoot: string,
  path: string,
  sessionId: string,
  branch: string | null
): void {
  acquireLock(db, {
    repoRoot,
    path,
    sessionId,
    mode: "exclusive",
    timeoutSeconds: 1800,
    branch,
  });
}

/** Seed an already-expired lock directly (acquireLock can't create the past). */
function seedExpired(
  repoRoot: string,
  path: string,
  sessionId: string,
  branch: string | null
): void {
  db.prepare(
    `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    repoRoot,
    path,
    sessionId,
    "exclusive",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:30:00.000Z",
    branch
  );
}

/** Base input on repo A, branch main, as MINE — tests override what they probe. */
function input(stagedPaths: string[], branch: string | null = "main") {
  return { repoRoot: REPO_A, branch, sessionId: MINE, stagedPaths };
}

describe("checkCommit", () => {
  it("blocks when another session holds a live same-branch lock, reporting path+lock", () => {
    const path = "/repos/alpha/src/db.ts";
    seedLive(REPO_A, path, OTHER, "main");

    const verdict = checkCommit(db, input([path]));

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.conflicts).toHaveLength(1);
      expect(verdict.conflicts[0]!.path).toBe(path);
      expect(verdict.conflicts[0]!.lock.session_id).toBe(OTHER);
    }
  });

  it("allows committing over your OWN live lock", () => {
    const path = "/repos/alpha/src/mine.ts";
    seedLive(REPO_A, path, MINE, "main");

    expect(checkCommit(db, input([path]))).toEqual({ allowed: true });
  });

  it("allows when the live lock is on a DIFFERENT branch (cross-branch never blocks)", () => {
    const path = "/repos/alpha/src/crossed.ts";
    seedLive(REPO_A, path, OTHER, "feature");

    expect(checkCommit(db, input([path], "main"))).toEqual({ allowed: true });
  });

  it("blocks a branchless committer on a branchless foreign lock (null matches null)", () => {
    const path = "/repos/alpha/src/branchless.ts";
    seedLive(REPO_A, path, OTHER, null);

    const verdict = checkCommit(db, input([path], null));

    expect(verdict.allowed).toBe(false);
  });

  it("allows when the foreign same-branch lock is EXPIRED", () => {
    const path = "/repos/alpha/src/stale.ts";
    seedExpired(REPO_A, path, OTHER, "main");

    expect(checkCommit(db, input([path]))).toEqual({ allowed: true });
  });

  it("allows when the same path string is locked only in a DIFFERENT repo (S1 isolation)", () => {
    const path = "src/index.ts";
    seedLive(REPO_B, path, OTHER, "main");

    expect(checkCommit(db, input([path]))).toEqual({ allowed: true });
  });

  it("reports ALL conflicts across multiple staged paths, not just the first", () => {
    const conflictA = "/repos/alpha/src/a.ts";
    const conflictB = "/repos/alpha/src/b.ts";
    const free = "/repos/alpha/src/free.ts";
    seedLive(REPO_A, conflictA, OTHER, "main");
    seedLive(REPO_A, conflictB, OTHER, "main");

    const verdict = checkCommit(db, input([conflictA, free, conflictB]));

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.conflicts.map((c) => c.path)).toEqual([conflictA, conflictB]);
    }
  });

  it("allows an empty staged set", () => {
    expect(checkCommit(db, input([]))).toEqual({ allowed: true });
  });
});

describe("checkCommit — multi-branch coexisting locks (M5.1b)", () => {
  const path = "/repos/alpha/src/multi.ts";

  it("allows a 'main' committer when the only live foreign lock is on 'feature'", () => {
    // Pre-M5.1b this was the flaky-allow scenario: an unfiltered checkLock
    // could hand back any row. Branch-filtered, "main" simply finds no lock.
    seedLive(REPO_A, path, OTHER, "feature");

    expect(checkCommit(db, input([path], "main"))).toEqual({ allowed: true });
  });

  it("blocks a 'main' committer with the MAIN row when foreign locks coexist on both branches", () => {
    // 'feature' seeded FIRST: an unfiltered lookup would land on that row by
    // scan order and wrongly wave the commit through — the gap M5.1b closes.
    seedLive(REPO_A, path, OTHER, "feature");
    seedLive(REPO_A, path, OTHER, "main");

    const verdict = checkCommit(db, input([path], "main"));

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.conflicts).toHaveLength(1);
      expect(verdict.conflicts[0]!.path).toBe(path);
      expect(verdict.conflicts[0]!.lock.branch).toBe("main");
      expect(verdict.conflicts[0]!.lock.session_id).toBe(OTHER);
    }
  });
});


=== src/hooks/pre-commit.ts ===
import type { MeshLockDatabase } from "../core/db.js";
import { checkLock, type Lock } from "../core/lock-engine.js";

/** One staged path that a live foreign lock refuses to let past. */
export interface CommitConflict {
  path: string;
  /** The blocking lock row — holder, branch, expiry — for the error message. */
  lock: Lock;
}

/**
 * The gate's answer — a discriminated union on `allowed`, same pattern as the
 * engine's AcquireResult and the daemon's Verdict. The blocked variant carries
 * EVERY conflict, not just the first: the committer should fix the complete
 * list off one failed commit, not discover them one fail-fix-fail at a time.
 */
export type HookVerdict =
  | { allowed: true }
  | { allowed: false; conflicts: CommitConflict[] };

/** Input to {@link checkCommit}. Everything resolved by the caller (M5.2). */
export interface CommitCheckInput {
  repoRoot: string;
  /** The committer's current branch; null = branchless (not a git branch head). */
  branch: string | null;
  /** This machine's session — its OWN locks never block its commits. */
  sessionId: string;
  /** ABSOLUTE staged paths — the M5.2 shim converts from repo-relative. */
  stagedPaths: string[];
}

/**
 * Decide whether a commit may proceed: block iff some staged path carries a
 * LIVE lock held by ANOTHER session on the SAME branch.
 *
 * The rules MIRROR the engine rather than re-invent it:
 *  - Liveness and expiry are checkLock's business — an expired lock reports
 *    as free and never blocks.
 *  - Own-session locks never block (`session_id === sessionId` is the
 *    committer's own declared claim).
 *  - Same-branch is enforced IN the lookup (M5.1b): the committer's branch is
 *    passed to checkLock, whose `branch IS ?` filter null-safely matches a
 *    branchless lock to a branchless committer — no re-comparison here.
 *  - A live lock on a DIFFERENT branch does not block, consistent with M2.5's
 *    cross-branch warn-not-block decision — the filter simply never returns it.
 *
 * The attribution limit (daemon/classify.ts) does NOT apply here: we are not
 * guessing who made an edit — we are refusing to commit over someone's
 * declared live claim. The BRANCH limit is RESOLVED for this consumer (M5.1b):
 * with coexisting per-branch locks on one path, the branch-filtered checkLock
 * deterministically returns the committer's-branch row (or none) instead of an
 * arbitrary branch's row.
 *
 * Pure and synchronous: no git, no fs, no config — branch and sessionId are
 * injected by the caller (M5.2), and the only I/O is checkLock per staged path.
 */
export function checkCommit(
  db: MeshLockDatabase,
  input: CommitCheckInput
): HookVerdict {
  const conflicts: CommitConflict[] = [];

  for (const path of input.stagedPaths) {
    // input.branch is string|null, never undefined → the lookup ALWAYS
    // branch-filters; cross-branch locks are excluded before we ever see them.
    const result = checkLock(db, input.repoRoot, path, input.branch);
    if (!result.held) continue; // free, or expired (checkLock's liveness)
    if (result.lock.session_id === input.sessionId) continue; // own claim
    conflicts.push({ path, lock: result.lock });
  }

  return conflicts.length > 0 ? { allowed: false, conflicts } : { allowed: true };
}


=== src/hooks/run.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock, type Lock } from "../core/lock-engine.js";
import { clearBranchCache, getRepoRoot } from "../core/git.js";
import { runPreCommit, type PreCommitDeps } from "./run.js";

const MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let dbDir: string;
let db: MeshLockDatabase;
let repoDir: string;
// getRepoRoot's symlink-canonical answer for repoDir — lock paths build on it.
let repoRoot: string;

/** Run a real git command in the temp repo; throw loudly on failure. */
function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

beforeEach(async () => {
  clearBranchCache();
  dbDir = await mkdtemp(join(tmpdir(), "meshlock-hookrun-db-"));
  db = openDatabase(join(dbDir, "test.db"));

  // A REAL repo on branch "main" with one commit, so HEAD (and thus the
  // branch) resolves and deletions have something to be staged against.
  repoDir = await mkdtemp(join(tmpdir(), "meshlock-hookrun-repo-"));
  git(["init", "-q", "-b", "main"], repoDir);
  git(["config", "user.email", "hook@test.local"], repoDir);
  git(["config", "user.name", "Hook Test"], repoDir);
  await writeFile(join(repoDir, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], repoDir);
  git(["commit", "-q", "-m", "seed"], repoDir);

  repoRoot = await getRepoRoot(repoDir);
});

afterEach(async () => {
  db.close();
  await rm(dbDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

/** Write + `git add` a file; return the canonical absolute path locks use. */
async function stage(rel: string, content = "content\n"): Promise<string> {
  await writeFile(join(repoDir, rel), content);
  git(["add", rel], repoDir);
  return join(repoRoot, rel);
}

/** Seed a live lock through the real engine; return the row (for expiry). */
function seedLock(path: string, sessionId: string, branch: string | null): Lock {
  const result = acquireLock(db, {
    repoRoot,
    path,
    sessionId,
    mode: "exclusive",
    timeoutSeconds: 1800,
    branch,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.lock;
}

function deps(): PreCommitDeps {
  return { db, cwd: repoDir, sessionId: MINE };
}

describe("runPreCommit", () => {
  it("exits 0 with no message on an empty stage", async () => {
    // Nothing staged after the seed commit.
    expect(await runPreCommit(deps())).toEqual({ exitCode: 0, message: null });
  });

  it("exits 0 with no message when staged files carry no locks", async () => {
    await stage("clean.ts");
    expect(await runPreCommit(deps())).toEqual({ exitCode: 0, message: null });
  });

  it("exits 1 naming path, holder, branch, and expiry on a foreign same-branch live lock", async () => {
    const abs = await stage("guarded.ts");
    const lock = seedLock(abs, OTHER, "main");

    const result = await runPreCommit(deps());

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("guarded.ts");
    expect(result.message).toContain(OTHER.slice(0, 8));
    expect(result.message).toContain("main");
    expect(result.message).toContain(lock.expires_at);
  });

  it("exits 0 over the session's OWN live lock", async () => {
    const abs = await stage("mine.ts");
    seedLock(abs, MINE, "main");

    expect(await runPreCommit(deps())).toEqual({ exitCode: 0, message: null });
  });

  it("lists EVERY conflict, not just the first", async () => {
    const a = await stage("a.ts");
    const b = await stage("b.ts");
    await stage("free.ts");
    seedLock(a, OTHER, "main");
    seedLock(b, OTHER, "main");

    const result = await runPreCommit(deps());

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("a.ts");
    expect(result.message).toContain("b.ts");
    expect(result.message).not.toContain("free.ts");
  });

  it("parses a filename containing a space via NUL splitting", async () => {
    const abs = await stage("has space.ts");
    seedLock(abs, OTHER, "main");

    const result = await runPreCommit(deps());

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("has space.ts");
  });

  it("gates a staged DELETION via the plain-join fallback (file is gone)", async () => {
    // seed.txt is committed and on disk; lock it as a foreign claim, then
    // stage its deletion — realpath ENOENTs, the join fallback must still
    // find the lock row.
    seedLock(join(repoRoot, "seed.txt"), OTHER, "main");
    git(["rm", "-q", "seed.txt"], repoDir);

    const result = await runPreCommit(deps());

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("seed.txt");
  });

  it("FAIL-OPEN: a broken DB exits 0 with a warning, never blocking the commit", async () => {
    await stage("anything.ts");
    const broken = openDatabase(join(dbDir, "broken.db"));
    broken.close(); // every statement on it now throws

    const result = await runPreCommit({ db: broken, cwd: repoDir, sessionId: MINE });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("fail-open");
  });
});


=== src/hooks/run.ts ===
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import type { MeshLockDatabase } from "../core/db.js";
import { getCurrentBranch, getRepoRoot } from "../core/git.js";
import { canonicalizePath } from "../core/paths.js";
import { checkCommit, type CommitConflict } from "./pre-commit.js";

/**
 * Everything runPreCommit needs, injected — db handle, working directory, and
 * this machine's session identity. The CLI assembles these from config; tests
 * pass temp equivalents and drive the runtime directly, no process spawning.
 */
export interface PreCommitDeps {
  db: MeshLockDatabase;
  /** Where git commands run — any directory inside the committing repo. */
  cwd: string;
  /** This machine's session — its own locks never block its commits. */
  sessionId: string;
}

/**
 * What the shim should do: `exitCode` becomes the hook process's exit status
 * (git aborts the commit on non-zero); `message` (if any) goes to STDERR —
 * either the conflict listing (exit 1) or a fail-open warning (exit 0).
 */
export interface PreCommitRunResult {
  exitCode: 0 | 1;
  message: string | null;
}

/**
 * List the staged paths, repo-relative, via `git diff --cached --name-only -z`.
 *
 * Parse on NUL, NEVER on newlines: a filename may itself contain a newline
 * (and in line mode git would quote such names, breaking naive parsing). NUL
 * is the one byte a path cannot contain, which is exactly why -z uses it.
 * spawnSync mirrors diff.ts; any git failure throws and is caught by the
 * fail-open wrapper in {@link runPreCommit}.
 */
function listStagedPaths(cwd: string): string[] {
  const result = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
    cwd,
    encoding: "utf-8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `git diff --cached exited with status ${String(result.status)}: ${result.stderr}`
    );
  }
  return result.stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * THE SEAM (M5.1 issue #3): convert one staged repo-relative path to the
 * absolute, symlink-canonical form locks are stored and checked under. Since
 * M6.1 the tools canonicalize with the SAME helper at their boundary, so both
 * sides of the comparison are canonical by construction — the M5.2 residual
 * risk (a lock stored under a non-canonical alias evading this gate) is
 * closed. A staged DELETION is subsumed by the helper's walk-up: the file is
 * gone but its parent exists, so the canonical parent + basename is exactly
 * the string the lock row carries.
 */
function toLockPath(repoRoot: string, staged: string): string {
  return canonicalizePath(join(repoRoot, staged));
}

/** One line per conflict — path, holder (first 8 chars), branch, expiry. */
function formatConflicts(repoRoot: string, conflicts: CommitConflict[]): string {
  const lines = conflicts.map(({ path, lock }) => {
    const rel = relative(repoRoot, path) || path;
    const holder = lock.session_id.slice(0, 8);
    const branch = lock.branch ?? "no branch";
    return `  ${rel} — held by session ${holder} (${branch}), expires ${lock.expires_at}`;
  });
  return [
    `[meshlock] commit blocked: ${String(conflicts.length)} staged path(s) carry a live lock held by another session on this branch:`,
    ...lines,
    "Wait for the lock(s) to be released or to expire, or coordinate with the holder.",
  ].join("\n");
}

/**
 * The pre-commit gate runtime: staged paths → canonical lock paths → branch →
 * checkCommit. Exit 1 (blocking the commit) iff checkCommit returns a positive
 * conflict verdict, with a message listing EVERY conflict so the committer
 * fixes the complete list off one failed commit.
 *
 * FAIL-OPEN (decided): ANY internal error — DB unopenable, git failure,
 * unexpected throw — exits 0 with a one-line warning instead of blocking.
 * Exit 1 is reserved for a positive verdict: an enforcement layer that bricks
 * commits when ITSELF broken gets uninstalled, and an uninstalled gate
 * protects nobody. The warning keeps the failure visible without making it
 * fatal.
 */
export async function runPreCommit(deps: PreCommitDeps): Promise<PreCommitRunResult> {
  try {
    const staged = listStagedPaths(deps.cwd);
    if (staged.length === 0) {
      return { exitCode: 0, message: null };
    }

    const repoRoot = await getRepoRoot(deps.cwd);
    const branch = await getCurrentBranch(deps.cwd);
    const stagedPaths = staged.map((rel) => toLockPath(repoRoot, rel));

    const verdict = checkCommit(deps.db, {
      repoRoot,
      branch,
      sessionId: deps.sessionId,
      stagedPaths,
    });

    if (verdict.allowed) {
      return { exitCode: 0, message: null };
    }
    return { exitCode: 1, message: formatConflicts(repoRoot, verdict.conflicts) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 0,
      message: `[meshlock] pre-commit check skipped (fail-open): ${detail}`,
    };
  }
}


=== src/index.ts ===
export {};


=== src/mcp/server.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { getRepoRoot } from "../core/git.js";
import type { Config } from "../core/config.js";
import { createServer } from "./server.js";
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

describe("createServer registration", () => {
  it("registers exactly the four MCP tools, discoverable via tools/list", async () => {
    const config: Config = {
      mode: "solo",
      session_id: SESSION,
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive",
      granularity: "file",
      cross_branch_mode: "warn",
    };
    const server = createServer(db, config);

    // A linked in-memory transport pair gives a real tools/list round-trip with
    // no child process and no stdio — so this exercises the registerTool wiring
    // in server.ts, which the handler-level tests never touch.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "meshlock-test", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "acquire_lock",
        "check_lock",
        "release_lock",
        "team_status",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});


=== src/mcp/server.ts ===
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { getDatabasePath, loadConfig, type Config } from "../core/config.js";
import { checkLockToolConfig, makeCheckLockHandler } from "./tools/check-lock.js";
import {
  acquireLockToolConfig,
  makeAcquireLockHandler,
} from "./tools/acquire-lock.js";
import {
  releaseLockToolConfig,
  makeReleaseLockHandler,
} from "./tools/release-lock.js";
import {
  teamStatusToolConfig,
  makeTeamStatusHandler,
} from "./tools/team-status.js";

/**
 * Create the MCP server and register MeshLock's tools against `db`. `config`
 * supplies the session identity and lock policy that mutating tools need.
 */
export function createServer(db: MeshLockDatabase, config: Config): McpServer {
  const server = new McpServer({ name: "meshlock", version: "0.1.0" });
  server.registerTool(
    "check_lock",
    checkLockToolConfig,
    makeCheckLockHandler(db)
  );
  server.registerTool(
    "acquire_lock",
    acquireLockToolConfig,
    makeAcquireLockHandler(db, config)
  );
  server.registerTool(
    "release_lock",
    releaseLockToolConfig,
    makeReleaseLockHandler(db, config)
  );
  server.registerTool(
    "team_status",
    teamStatusToolConfig,
    makeTeamStatusHandler(db, config)
  );
  return server;
}

/**
 * Boot: open the DB once, build the server, connect stdio. Exported so the CLI
 * (`meshlock serve`) can reuse the exact same boot path; behavior is unchanged.
 *
 * stdout is the MCP protocol channel and MUST stay clean — any JSON written
 * there that isn't a protocol message will corrupt the stream. All diagnostics
 * therefore go to stderr (console.error), never console.log.
 */
export async function startServer(): Promise<void> {
  const db = openDatabase(getDatabasePath());
  const config = await loadConfig();
  const server = createServer(db, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Boot diagnostic on stderr only — stdout stays reserved for the protocol.
  console.error("meshlock MCP server started (stdio)");
}

// Run only when executed directly, so importing this module in tests is a no-op.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error("meshlock MCP server failed to start:", err);
    process.exit(1);
  });
}


=== src/mcp/tools/acquire-lock.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../../core/db.js";
import { acquireLock, checkLock, type CrossBranchMode } from "../../core/lock-engine.js";
import { recordChange } from "../../core/changes.js";
import type { Config } from "../../core/config.js";
import { clearBranchCache, getRepoRoot } from "../../core/git.js";
import { makeAcquireLockHandler } from "./acquire-lock.js";

// The tool now resolves the branch from process.cwd(). We chdir into a non-git
// temp dir for each test so that resolution falls back to null deterministically
// (vitest itself runs inside the meshlock git repo). Restored in afterEach.
const ORIGINAL_CWD = process.cwd();

let tempDir: string;
let db: MeshLockDatabase;
// The repo_root the handler resolves from each path's dir (cwd === tempDir here).
// Seeds use the same value so they land in the repo the handler queries.
let repoRoot: string;

// The session the tool acts as (from config) and a different session we seed
// conflicting locks under.
const CONFIG_SESSION = "44444444-4444-4444-8444-444444444444";
const OTHER_SESSION = "55555555-5555-4555-8555-555555555555";

function makeConfig(crossBranchMode: CrossBranchMode = "warn"): Config {
  return {
    mode: "solo",
    session_id: CONFIG_SESSION,
    relay_url: null,
    lock_timeout: 1800,
    lock_mode: "exclusive",
    granularity: "file",
    cross_branch_mode: crossBranchMode,
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

function rowCount(path: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM locks WHERE path = ?").get(path) as {
      n: number;
    }
  ).n;
}

function branchOf(path: string): string | null {
  return (
    db.prepare("SELECT branch FROM locks WHERE path = ?").get(path) as {
      branch: string | null;
    }
  ).branch;
}

function snapshotOf(path: string): string | null {
  return (
    db.prepare("SELECT content_snapshot FROM locks WHERE path = ?").get(path) as {
      content_snapshot: string | null;
    }
  ).content_snapshot;
}

beforeEach(async () => {
  // A temp dir under the OS tmp root: it exists but is NOT a git repo. We chdir
  // into it so the tool's branch resolution (process.cwd()) falls back to null.
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-acquire-test-"));
  db = openDatabase(join(tempDir, "test.db"));
  process.chdir(tempDir);
  clearBranchCache();
  repoRoot = await getRepoRoot(tempDir);
});

afterEach(async () => {
  // Restore cwd before removing the temp dir we were sitting in.
  process.chdir(ORIGINAL_CWD);
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("acquire_lock handler", () => {
  it("acquires a free path and writes the lock row", async () => {
    const path = join(tempDir, "free.ts");
    const handler = makeAcquireLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(text).toContain("no branch");
    expect(rowCount(path)).toBe(1);
  });

  it("falls back to a branchless lock when there is no git repo (does not throw)", async () => {
    // cwd is the non-git temp dir, so branch resolution returns null —
    // proving git is not a hard requirement.
    const path = join(tempDir, "nogit.ts");
    const handler = makeAcquireLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(branchOf(path)).toBeNull();
  });

  it("reports a held conflict instead of throwing", async () => {
    const path = join(tempDir, "taken.ts");
    // Another session already holds this branchless lock.
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });

    const handler = makeAcquireLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("LOCKED");
    expect(text).toContain(OTHER_SESSION);
    expect(rowCount(path)).toBe(1);
  });

  it("config cross_branch_mode 'block' reaches the engine and blocks a cross-branch acquire", async () => {
    const path = join(tempDir, "cross.ts");
    // A lock on another branch held by another session.
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    // Tool resolves branch=null here; with config "block" the engine must block.
    const handler = makeAcquireLockHandler(db, makeConfig("block"));
    const text = firstText(await handler({ path }));

    expect(text).toContain("LOCKED");
    expect(text).toContain(OTHER_SESSION);
    // Only the seeded "main" row exists; the null-branch acquire was refused.
    expect(rowCount(path)).toBe(1);
  });

  it("config cross_branch_mode 'warn' reaches the engine and acquires with a warning", async () => {
    const path = join(tempDir, "cross.ts");
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });

    const handler = makeAcquireLockHandler(db, makeConfig("warn"));
    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(text).toContain("WARNING");
    expect(text).toContain("main");
    expect(text).toContain(OTHER_SESSION);
    // Both locks now coexist: the seeded "main" plus our branchless one.
    expect(rowCount(path)).toBe(2);
  });

  it("captures the file's content as the snapshot when the file exists", async () => {
    const path = join(tempDir, "withcontent.ts");
    await writeFile(path, "export const answer = 42;\n");
    const handler = makeAcquireLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(snapshotOf(path)).toBe("export const answer = 42;\n");
  });

  it("captures a null snapshot for a non-existent path and does not throw", async () => {
    // The file is never created — reading it ENOENTs, which the tool swallows.
    const path = join(tempDir, "ghost.ts");
    const handler = makeAcquireLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(snapshotOf(path)).toBeNull();
  });
});

describe("acquire_lock handler — briefing (M3.5c)", () => {
  it("includes recent change history in the response when the path has prior changes", async () => {
    const path = join(tempDir, "briefed.ts");
    // Seed a prior change on this path+branch (branch null in the non-git tempDir,
    // matching what the handler resolves).
    recordChange(db, {
      repoRoot,
      path,
      branch: null,
      sessionId: OTHER_SESSION,
      diff: "@@ -1 +1 @@\n-old\n+new\n",
      summary: "tweaked the export",
      changedAt: "2026-06-01T00:00:00.000Z",
    });

    const handler = makeAcquireLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(text).toContain("Recent changes to this path:");
    expect(text).toContain("tweaked the export"); // summary becomes the headline
    expect(text).toContain(OTHER_SESSION.slice(0, 8));
  });

  it("shows no history section when the path has no prior changes", async () => {
    const path = join(tempDir, "untracked.ts");
    const handler = makeAcquireLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Acquired");
    expect(text).not.toContain("Recent changes");
  });
});

describe("acquire_lock handler — path canonicalization (M6.1)", () => {
  it("stores the canonical path for a symlink-aliased acquire so canonical lookups find it", async () => {
    // The M5.2 evasion case, pinned closed: acquire through an ALIAS, then look
    // up the way the hook/daemon do — under the CANONICAL path — and find it.
    await mkdir(join(tempDir, "real"));
    await symlink(join(tempDir, "real"), join(tempDir, "alias"));
    const realDir = await realpath(join(tempDir, "real"));
    const canonicalPath = join(realDir, "target.ts");
    await writeFile(canonicalPath, "export const t = 1;\n");

    const handler = makeAcquireLockHandler(db, makeConfig());
    const text = firstText(await handler({ path: join(tempDir, "alias", "target.ts") }));
    expect(text).toContain("Acquired");

    // The stored row carries the canonical string, not the alias.
    const stored = db.prepare("SELECT path FROM locks").all() as { path: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.path).toBe(canonicalPath);

    // A hook-style lookup under the canonical path finds the lock — resolving
    // repoRoot the same way the handler did (from the file's real directory).
    const lookupRepo = await getRepoRoot(realDir);
    expect(checkLock(db, lookupRepo, canonicalPath).held).toBe(true);
  });
});


=== src/mcp/tools/acquire-lock.ts ===
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import type { Config } from "../../core/config.js";
import { acquireLock } from "../../core/lock-engine.js";
import { getCurrentBranch, getRepoRoot } from "../../core/git.js";
import { getChanges, type ChangeRecord } from "../../core/changes.js";
import { canonicalizePath } from "../../core/paths.js";

/**
 * Read the file at `path` as the acquire-time baseline snapshot (M3.5b). This is
 * the TOOL's job, not the engine's: the engine never touches the filesystem, so
 * the tool reads here — OUTSIDE the engine transaction — and injects the content.
 * A missing or unreadable file is NOT an error: there is simply no baseline yet
 * (e.g. the agent is about to CREATE the file), so we capture null and let M3.5c
 * treat a null baseline as "new file" (all content reported as additions).
 */
function captureSnapshot(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * A compact one-line hint from a recorded diff, for the acquire briefing. Prefers
 * the first genuinely-changed line (a +/- line that is not the +++/--- header);
 * an empty diff (a recorded no-op) reads as "(no content change)".
 */
function diffPreview(diff: string): string {
  if (diff === "") return "(no content change)";
  const changed = diff
    .split("\n")
    .find(
      (l) =>
        (l.startsWith("+") || l.startsWith("-")) &&
        !l.startsWith("+++") &&
        !l.startsWith("---")
    );
  const preview = (changed ?? diff.split("\n")[0] ?? "").trim();
  return preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
}

/**
 * One briefing line for a recorded change. Headline prefers diff_stat, then the
 * agent-written summary, then a diff preview — diff_stat/summary are enrichment
 * and may be absent, so the diff (the floor) is the guaranteed fallback.
 */
function formatChange(c: ChangeRecord): string {
  const who = `${c.sessionId.slice(0, 8)}…`;
  const headline = c.diffStat ?? c.summary ?? diffPreview(c.diff);
  return `- ${c.changedAt} by ${who}: ${headline}`;
}

/**
 * Input shape for `acquire_lock`. Only `path` — the tool resolves the git branch
 * itself, so the agent never supplies it.
 */
export const acquireLockInputSchema = {
  path: z
    .string()
    .describe("The file or directory path to lock, e.g. /repo/src/index.ts"),
};

/** Tool name and description, surfaced to the agent in the tools list. */
export const acquireLockToolConfig = {
  description:
    "Acquire a lock on a file path before editing it, so other agents don't edit it at the same time.",
  inputSchema: acquireLockInputSchema,
} as const;

/**
 * Build the `acquire_lock` handler bound to a database and the loaded config.
 * Config supplies session_id / lock_mode / lock_timeout / cross_branch_mode so
 * the handler never re-reads config per call. The handler is async because
 * resolving the branch is async — but that git I/O happens BEFORE the
 * synchronous engine call, never inside its transaction.
 *
 * Both repo_root AND branch resolve from the FILE's directory (dirname(path)):
 * repo membership and the branch of that repo both depend on where the file
 * lives. Resolving the branch from the file's own repo — not the daemon's cwd —
 * keeps the lock coherent even when the file is in a different repo than the
 * daemon is running in (the S1c-issue-#1 fix).
 *
 * NOTE: M3.2c moved this from dirname(path) to cwd; S1c moves it back. Not a
 * flip-flop — getCurrentBranch(dirname(path)) still resolves the whole repo's
 * HEAD (git walks up), and once `meshlock init` made the daemon user-global,
 * cwd points at the DAEMON's repo, not the file's. See the M3.3b learning-log
 * "reconciling with M3.2c" note.
 */
export function makeAcquireLockHandler(db: MeshLockDatabase, config: Config) {
  return async ({ path: rawPath }: { path: string }): Promise<CallToolResult> => {
    // Canonicalize at the boundary (M6.1): everything downstream — branch and
    // repo resolution, the engine lookup, the briefing query — sees the
    // symlink-free form, so an aliased path can't evade the hook or the daemon.
    const path = canonicalizePath(rawPath);
    const branch = await getCurrentBranch(dirname(path));
    const repoRoot = await getRepoRoot(dirname(path));
    // Capture the baseline now, before the engine call. The engine ignores this
    // on a same-session refresh and keeps the original baseline.
    const contentSnapshot = captureSnapshot(path);

    const result = acquireLock(db, {
      repoRoot,
      path,
      sessionId: config.session_id,
      mode: config.lock_mode,
      timeoutSeconds: config.lock_timeout,
      branch,
      crossBranchMode: config.cross_branch_mode,
      contentSnapshot,
    });

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Could not acquire "${path}" — it is LOCKED by session ` +
              `${result.heldBy}. Back off and retry later, or coordinate with ` +
              `that session.`,
          },
        ],
      };
    }

    const where = branch ? `branch ${branch}` : "no branch";
    let text =
      `Acquired lock on "${path}" (${where}) until ${result.lock.expires_at}.`;

    if (result.warning) {
      const otherBranch = result.warning.otherBranch ?? "(no branch)";
      text +=
        ` WARNING: this path is also locked on ${otherBranch} by session ` +
        `${result.warning.heldBy} — a cross-branch conflict is possible when ` +
        `the branches merge.`;
    }

    // Briefing (M3.5c): surface what recent sessions changed on this path+branch,
    // so the new holder starts informed. A read-only lookup, after the acquire;
    // when there is no history we add no section (graceful, not an error).
    const history = getChanges(db, { repoRoot, path, branch, limit: 5 });
    if (history.length > 0) {
      text += `\n\nRecent changes to this path:\n${history.map(formatChange).join("\n")}`;
    }

    return { content: [{ type: "text", text }] };
  };
}


=== src/mcp/tools/check-lock.ts ===
import { dirname } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import { checkLock } from "../../core/lock-engine.js";
import { getRepoRoot } from "../../core/git.js";
import { canonicalizePath } from "../../core/paths.js";

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
  return async ({ path: rawPath }: { path: string }): Promise<CallToolResult> => {
    // Canonicalize at the boundary (M6.1) — see core/paths.ts.
    const path = canonicalizePath(rawPath);
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


=== src/mcp/tools/release-lock.test.ts ===
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../../core/db.js";
import { acquireLock } from "../../core/lock-engine.js";
import { getChanges } from "../../core/changes.js";
import type { Config } from "../../core/config.js";
import { getRepoRoot } from "../../core/git.js";
import { makeReleaseLockHandler } from "./release-lock.js";

let tempDir: string;
let db: MeshLockDatabase;
// The repo_root the handler resolves from each path's dir (== tempDir here).
let repoRoot: string;

// The session the tool acts as (from config) and a different session we seed
// other-owner locks under.
const CONFIG_SESSION = "66666666-6666-4666-8666-666666666666";
const OTHER_SESSION = "77777777-7777-4777-8777-777777777777";

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

/** Pull the plain text out of a CallToolResult for assertions. */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) {
    throw new Error("expected a text content block");
  }
  return block.text;
}

function rowCount(path: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM locks WHERE path = ?").get(path) as {
      n: number;
    }
  ).n;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-release-test-"));
  db = openDatabase(join(tempDir, "test.db"));
  repoRoot = await getRepoRoot(tempDir);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("release_lock handler", () => {
  it("releases a lock the calling session owns", async () => {
    const path = join(tempDir, "mine.ts");
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: CONFIG_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Released");
    expect(rowCount(path)).toBe(0);
  });

  it("is a no-op on a lock owned by another session", async () => {
    const path = join(tempDir, "theirs.ts");
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
    });

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Nothing to release");
    // The other session's lock is untouched.
    expect(rowCount(path)).toBe(1);
  });

  it("is a clean no-op on a path with no lock at all", async () => {
    const path = join(tempDir, "never-locked.ts");
    const handler = makeReleaseLockHandler(db, makeConfig());

    const text = firstText(await handler({ path }));

    expect(text).toContain("Nothing to release");
  });

  it("releases all of the session's locks on a path across branches", async () => {
    const path = join(tempDir, "multi.ts");
    // Same session holds the same path on two different branches.
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: CONFIG_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "main",
    });
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: CONFIG_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: "feature",
    });
    expect(rowCount(path)).toBe(2);

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    // Branch-agnostic: a single release drops both branch locks.
    expect(text).toContain("Released");
    expect(rowCount(path)).toBe(0);
  });
});

describe("release_lock handler — change recording (M3.5c)", () => {
  /** Acquire with a baseline snapshot, simulating M3.5b's acquire-time capture. */
  function acquireWithSnapshot(path: string, snapshot: string): void {
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: CONFIG_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
      contentSnapshot: snapshot,
    });
  }

  it("records a diff when the file changed between acquire and release", async () => {
    const path = join(tempDir, "edited.ts");
    await writeFile(path, "old content\n");
    acquireWithSnapshot(path, "old content\n");
    // The "edit" the holder made while owning the lock.
    await writeFile(path, "new content\n");

    const handler = makeReleaseLockHandler(db, makeConfig());
    await handler({ path });

    const changes = getChanges(db, { repoRoot, path });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.diff).toContain("-old content");
    expect(changes[0]!.diff).toContain("+new content");
  });

  it("records an empty diff (the floor) when content is unchanged", async () => {
    const path = join(tempDir, "untouched.ts");
    await writeFile(path, "same\n");
    acquireWithSnapshot(path, "same\n");

    const handler = makeReleaseLockHandler(db, makeConfig());
    await handler({ path });

    const changes = getChanges(db, { repoRoot, path });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.diff).toBe("");
  });

  it("passes an optional summary through to the change record", async () => {
    const path = join(tempDir, "summarised.ts");
    await writeFile(path, "before\n");
    acquireWithSnapshot(path, "before\n");
    await writeFile(path, "after\n");

    const handler = makeReleaseLockHandler(db, makeConfig());
    await handler({ path, summary: "rewrote the greeting" });

    const changes = getChanges(db, { repoRoot, path });
    expect(changes[0]!.summary).toBe("rewrote the greeting");
  });

  it("skips recording (no row, no throw) when the file is binary", async () => {
    const path = join(tempDir, "asset.bin");
    await writeFile(path, "before\n");
    acquireWithSnapshot(path, "before\n");
    // The current content is now binary — a NUL byte makes a utf-8 diff garbage.
    await writeFile(path, Buffer.from([0x00, 0x01, 0x02, 0x00]));

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Released");
    expect(getChanges(db, { repoRoot, path })).toHaveLength(0);
  });

  it("records a change when releasing an EXPIRED lock it owned (M5.1c — the lost-record gap)", async () => {
    const path = join(tempDir, "expired-owned.ts");
    await writeFile(path, "after\n");
    // Seed an EXPIRED own lock directly, baseline snapshot intact. Before
    // M5.1c the pre-release checkLock reported it as free, so the diff was
    // silently dropped; the deleted row now carries the baseline out.
    db.prepare(
      `INSERT INTO locks (repo_root, path, session_id, mode, acquired_at, expires_at, branch, content_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      repoRoot,
      path,
      CONFIG_SESSION,
      "exclusive",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:30:00.000Z",
      null,
      "before\n"
    );

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Released");
    const changes = getChanges(db, { repoRoot, path });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.diff).toContain("-before");
    expect(changes[0]!.diff).toContain("+after");
  });

  it("records one change per branch on a multi-branch release, each against its own baseline", async () => {
    const path = join(tempDir, "per-branch.ts");
    await writeFile(path, "current\n");
    for (const branch of ["main", "feature"]) {
      acquireLock(db, {
        repoRoot,
        path,
        sessionId: CONFIG_SESSION,
        mode: "exclusive",
        timeoutSeconds: 1800,
        branch,
        contentSnapshot: `${branch}-base\n`,
        crossBranchMode: "ignore",
      });
    }

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));
    expect(text).toContain("Released");

    // Two records total, one per branch, each diffed from that branch's baseline.
    expect(getChanges(db, { repoRoot, path })).toHaveLength(2);
    for (const branch of ["main", "feature"]) {
      const changes = getChanges(db, { repoRoot, path, branch });
      expect(changes).toHaveLength(1);
      expect(changes[0]!.diff).toContain(`-${branch}-base`);
      expect(changes[0]!.diff).toContain("+current");
    }
  });

  it("does not record when releasing a lock owned by another session", async () => {
    const path = join(tempDir, "not-mine.ts");
    await writeFile(path, "content\n");
    acquireLock(db, {
      repoRoot,
      path,
      sessionId: OTHER_SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
      branch: null,
      contentSnapshot: "content\n",
    });

    const handler = makeReleaseLockHandler(db, makeConfig());
    const text = firstText(await handler({ path }));

    expect(text).toContain("Nothing to release");
    expect(getChanges(db, { repoRoot, path })).toHaveLength(0);
  });
});


=== src/mcp/tools/release-lock.ts ===
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
import { canonicalizePath } from "../../core/paths.js";

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
    path: rawPath,
    summary,
  }: {
    path: string;
    summary?: string;
  }): Promise<CallToolResult> => {
    // Canonicalize at the boundary (M6.1) — a release must find the same row
    // the (canonicalized) acquire wrote, whatever alias the agent used today.
    const path = canonicalizePath(rawPath);
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


=== src/mcp/tools/team-status.test.ts ===
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


=== src/mcp/tools/team-status.ts ===
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MeshLockDatabase } from "../../core/db.js";
import type { Config } from "../../core/config.js";
import { listLocks } from "../../core/lock-engine.js";
import { getCurrentBranch, getRepoRoot } from "../../core/git.js";

/**
 * Input shape for `team_status`. None — the tool surveys every active lock. An
 * empty shape advertises a no-argument tool in tools/list.
 */
export const teamStatusInputSchema = {};

/** Tool name and description, surfaced to the agent in the tools list. */
export const teamStatusToolConfig = {
  description:
    "List all files currently locked across the team, who holds each, and on which branch — to see what's being worked on before you start editing.",
  inputSchema: teamStatusInputSchema,
} as const;

/**
 * Build the `team_status` handler. This tool mutates nothing — it reads every
 * active lock and resolves the agent's own branch so it can mark which locks sit
 * on that branch (the ones that directly contend with the agent's work) versus
 * those that merely coexist on other branches.
 *
 * `config` is accepted for signature consistency with the other tool factories
 * (and forthcoming team-mode needs); team_status reads no config field today.
 * The handler is async because resolving the repo and branch is async.
 *
 * Unlike the per-path tools, team_status has no single path, so it scopes to the
 * DAEMON's repo: getRepoRoot() and getCurrentBranch() both default to cwd. The
 * result is a per-repo survey ("what's locked in this repo").
 */
export function makeTeamStatusHandler(db: MeshLockDatabase, config: Config) {
  void config;
  return async (): Promise<CallToolResult> => {
    const repoRoot = await getRepoRoot();
    const locks = listLocks(db, repoRoot);
    const currentBranch = await getCurrentBranch();

    if (locks.length === 0) {
      return { content: [{ type: "text", text: "No active locks." }] };
    }

    const lines = locks.map((lock) => {
      const branchLabel = lock.branch ?? "no branch";
      // null === null is true, so a branchless agent matches branchless locks —
      // consistent with the engine's "two nulls are the same branch" semantics.
      const mine = lock.branch === currentBranch ? " ← your branch" : "";
      return (
        `- ${lock.path}  [branch: ${branchLabel}]  ` +
        `held by ${lock.session_id}  until ${lock.expires_at}${mine}`
      );
    });

    const header = `${locks.length} active lock${locks.length === 1 ? "" : "s"}:`;
    const text = [header, ...lines].join("\n");
    return { content: [{ type: "text", text }] };
  };
}


=== migrations ===

--- data/migrations/001_create_locks.sql ---
-- Locks held by sessions over filesystem paths.
-- A path may be a single file or a directory; granularity is decided by the
-- caller (see config.ts `granularity`). The path itself is the lock identity.
CREATE TABLE locks (
  -- The locked path. One row per path => one holder at a time.
  path TEXT PRIMARY KEY,
  -- The session that holds the lock (config.ts `session_id`, a uuid string).
  session_id TEXT NOT NULL,
  -- "exclusive" | "advisory" — matches config.ts `lock_mode`.
  mode TEXT NOT NULL,
  -- ISO-8601 timestamp when the lock was acquired.
  acquired_at TEXT NOT NULL,
  -- ISO-8601 timestamp when the lock expires (acquired_at + lock_timeout).
  expires_at TEXT NOT NULL
);

--- data/migrations/002_add_branch_to_locks.sql ---
-- Add a branch dimension to locks: the same path can be locked independently on
-- different git branches. SQLite cannot drop a PRIMARY KEY or add a multi-column
-- UNIQUE constraint in place, so we rebuild the table (the standard SQLite
-- table-redefinition pattern).
--
-- The migration runner in db.ts already wraps each migration file in a single
-- transaction, so all four steps below commit together or not at all. Do NOT add
-- a BEGIN/COMMIT here — that would nest transactions and fight the runner.

-- Step 1: new table. `branch` is nullable; NULL means "no branch / not a git
-- repo". Lock identity is now the pair (path, branch) rather than path alone, so
-- the same path can be held once per branch.
CREATE TABLE locks_new (
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  branch TEXT,
  UNIQUE(path, branch)
);

-- Step 2: copy every existing row across. Pre-branch locks become branchless
-- (branch = NULL), which the engine treats as one shared logical branch.
INSERT INTO locks_new (path, session_id, mode, acquired_at, expires_at, branch)
  SELECT path, session_id, mode, acquired_at, expires_at, NULL FROM locks;

-- Step 3: drop the old table.
DROP TABLE locks;

-- Step 4: rename the rebuilt table into place.
ALTER TABLE locks_new RENAME TO locks;

--- data/migrations/003_add_repo_root_to_locks.sql ---
-- Add a repo_root dimension to locks so a globally-launched MCP server (one
-- `meshlock init` registration for all repos) can scope locks per repository.
-- Lock identity becomes (repo_root, path, branch). SQLite cannot extend a
-- multi-column UNIQUE constraint in place, so we rebuild the table (same pattern
-- as 002).
--
-- The migration runner in db.ts already wraps each migration file in a single
-- transaction, so all four steps commit together or not at all. Do NOT add a
-- BEGIN/COMMIT here — that would nest transactions and fight the runner.

-- Step 1: new table. repo_root is NOT NULL: it is a sentinel (the git repo root,
-- or the file's own directory when not in a repo), never NULL. Keeping it non-null
-- avoids the NULL-uniqueness trap that branch deliberately lives in, so
-- UNIQUE(repo_root, path, branch) behaves normally on the repo_root column.
--
-- The DEFAULT '(unknown)' lets the lock engine — which is NOT updated in this
-- milestone and whose INSERT does not yet list repo_root — keep writing valid
-- rows. S1b/S1c update the engine and the tools to supply a real repo_root; until
-- then new rows fall back to the same sentinel as the backfill below.
CREATE TABLE locks_new (
  repo_root TEXT NOT NULL DEFAULT '(unknown)',
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  branch TEXT,
  UNIQUE(repo_root, path, branch)
);

-- Step 2: copy existing rows. repo_root is NOT NULL, so pre-S1 rows need a value.
-- '(unknown)' is a backfill placeholder for rows that predate repo scoping — in
-- practice there are none (no production data yet). Live rows get a real repo_root
-- from getRepoRoot at acquire time (S1b/S1c).
INSERT INTO locks_new (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
  SELECT '(unknown)', path, session_id, mode, acquired_at, expires_at, branch FROM locks;

-- Step 3: drop the old table.
DROP TABLE locks;

-- Step 4: rename the rebuilt table into place.
ALTER TABLE locks_new RENAME TO locks;

--- data/migrations/004_drop_repo_root_default.sql ---
-- Remove the repo_root DEFAULT that 003 added. In S1a the default '(unknown)'
-- let the not-yet-updated engine keep writing rows. As of S1b the engine supplies
-- repo_root explicitly, so the default's only remaining effect would be to
-- SILENTLY absorb a future missing-repo_root bug into a fake '(unknown)' repo.
-- For an identity column that is the worst failure mode, so we drop the default:
-- an INSERT that omits repo_root must now throw (loud failure = correct).
--
-- SQLite cannot drop a column default in place, so we rebuild the table (same
-- pattern as 002/003). The runner wraps this file in one transaction — do NOT add
-- a BEGIN/COMMIT here.

-- Step 1: new table, identical to the post-003 shape EXCEPT repo_root has no
-- DEFAULT. It stays NOT NULL, and uniqueness stays (repo_root, path, branch).
CREATE TABLE locks_new (
  repo_root TEXT NOT NULL,
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  branch TEXT,
  UNIQUE(repo_root, path, branch)
);

-- Step 2: copy every row across. Existing rows already have a repo_root value
-- (from 003), so we copy it directly — no literal/backfill needed this time.
INSERT INTO locks_new (repo_root, path, session_id, mode, acquired_at, expires_at, branch)
  SELECT repo_root, path, session_id, mode, acquired_at, expires_at, branch FROM locks;

-- Step 3: drop the old table.
DROP TABLE locks;

-- Step 4: rename the rebuilt table into place.
ALTER TABLE locks_new RENAME TO locks;

--- data/migrations/005_change_log.sql ---
-- Change-briefing foundation: storage for "what the previous agent changed",
-- so the next agent to acquire a path can be briefed before it starts.
--
-- Two coherent additions with OPPOSITE lifecycles, which is why they live in
-- two different places:
--
--   1. locks.content_snapshot — the baseline file content captured at ACQUIRE.
--      It belongs on the lock row because it dies WITH the lock: once the holder
--      releases, the baseline has done its job (the diff has been computed) and
--      goes away with the row. M3.5b wires the capture; this migration only adds
--      the column.
--
--   2. change_log — the recorded change, created at RELEASE. It must OUTLIVE the
--      lock (the whole point is to brief the NEXT acquirer, who shows up after
--      this lock is gone), so it cannot live on the locks row. Hence its own
--      append-only table.
--
-- The runner in db.ts wraps this whole file in one transaction — do NOT add a
-- BEGIN/COMMIT here (that would nest and fight the runner), same as 003/004.

-- Step 1: add the per-lock baseline snapshot. This is a CHEAP IN-PLACE add, NOT
-- a table rebuild like 002/003/004. Those rebuilt the table because they changed
-- a multi-column UNIQUE constraint, which SQLite cannot alter in place. Adding a
-- plain NULLABLE column with no default is just a metadata change, so a simple
-- ALTER TABLE ... ADD COLUMN suffices.
--
-- NULLABLE with NO DEFAULT on purpose: until M3.5b wires acquire-time capture,
-- the lock engine's INSERT does not list content_snapshot, so every row arrives
-- without one — a legitimately absent snapshot must be allowed. This is the
-- deliberate INVERSE of S1a's repo_root (a non-null identity column where a
-- missing value is a bug worth failing loud over). A missing snapshot is not a
-- bug; it is the normal state for a lock taken before capture exists.
ALTER TABLE locks ADD COLUMN content_snapshot TEXT;

-- Step 2: the append-only change log. A surrogate INTEGER id (not the
-- (repo_root, path, branch) identity that locks uses) because this is a LOG:
-- many rows per path over time is the entire feature, so there is deliberately
-- NO UNIQUE constraint on the identity triple. That accumulated history is what
-- the next acquirer reads.
CREATE TABLE change_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,   -- surrogate key: a log has many rows per identity
  repo_root    TEXT NOT NULL,                       -- repo scoping (S1 discipline) — always filtered first
  path         TEXT NOT NULL,
  branch       TEXT,                                -- nullable, same NULL-means-branchless rule as locks
  session_id   TEXT NOT NULL,                       -- who made the change
  diff         TEXT NOT NULL,                       -- the floor: unified diff (may be "" for a no-op change)
  summary      TEXT,                                -- optional enrichment, agent-supplied at release
  diff_stat    TEXT,                                -- optional headline (e.g. "2 files, +42 -17")
  changed_at   TEXT NOT NULL                        -- ISO-8601 UTC, ms precision — SAME format as lock expiry
);

-- Lookup index matching how getChanges queries: by (repo_root, path, branch).
CREATE INDEX idx_change_log_lookup ON change_log (repo_root, path, branch);
