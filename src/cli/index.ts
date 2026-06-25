#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { startServer } from "../mcp/server.js";
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

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "init":
      await runInit();
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
