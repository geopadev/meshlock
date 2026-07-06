#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { startServer } from "../mcp/server.js";
import { openDatabase } from "../core/db.js";
import { getDatabasePath, loadConfig } from "../core/config.js";
import { getRepoRoot } from "../core/git.js";
import { startDaemon } from "../daemon/index.js";
import { installHook } from "../hooks/install.js";
import { runPreCommit } from "../hooks/run.js";
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

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "init":
      await runInit();
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
