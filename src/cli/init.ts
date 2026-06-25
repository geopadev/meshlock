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
