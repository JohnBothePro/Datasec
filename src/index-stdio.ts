#!/usr/bin/env node
/**
 * Datasec MCP — stdio transport (Claude Desktop, Cursor local, etc.)
 * Logs go to stderr only so they never corrupt the protocol stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDatasecServer } from "./tools.js";
import { session } from "./client.js";
import { helpersEnabled } from "./helpers/envelope.js";

async function main(): Promise<void> {
  // Ensure token attempt at startup (never print value)
  session.reloadToken();
  const server = createDatasecServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[datasec-mcp] stdio ready env=${session.env} tokenLoaded=${session.tokenLoaded} writes=${session.writesEnabled} helpers=${helpersEnabled()}`
  );
}

main().catch((err) => {
  console.error("[datasec-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
