#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { startServer } from "../mcp/server.js";
import { openDatabase } from "../core/db.js";
import { getDatabasePath, loadConfig } from "../core/config.js";
import { getRepoRoot } from "../core/git.js";
import { startDaemon } from "../daemon/index.js";
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
    "  init    Register the meshlock MCP server in Claude Code's user config",
    "  serve   Start the MCP server over stdio (how Claude Code launches it)",
    "  watch   Watch the current repo and warn about edits to unlocked paths",
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

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "init":
      await runInit();
      return;
    case "watch":
      await runWatch();
      return;
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
