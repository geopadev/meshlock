import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { getDatabasePath } from "../core/config.js";
import { checkLockToolConfig, makeCheckLockHandler } from "./tools/check-lock.js";

/** Create the MCP server and register MeshLock's tools against `db`. */
export function createServer(db: MeshLockDatabase): McpServer {
  const server = new McpServer({ name: "meshlock", version: "0.1.0" });
  server.registerTool(
    "check_lock",
    checkLockToolConfig,
    makeCheckLockHandler(db)
  );
  return server;
}

/**
 * Boot: open the DB once, build the server, connect stdio.
 *
 * stdout is the MCP protocol channel and MUST stay clean — any JSON written
 * there that isn't a protocol message will corrupt the stream. All diagnostics
 * therefore go to stderr (console.error), never console.log.
 */
async function main(): Promise<void> {
  const db = openDatabase(getDatabasePath());
  const server = createServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Boot diagnostic on stderr only — stdout stays reserved for the protocol.
  console.error("meshlock MCP server started (stdio)");
}

// Run only when executed directly, so importing this module in tests is a no-op.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("meshlock MCP server failed to start:", err);
    process.exit(1);
  });
}
