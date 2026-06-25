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
