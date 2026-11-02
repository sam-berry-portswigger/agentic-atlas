#!/usr/bin/env node
import { fileURLToPath } from "node:url";
// MCP clients may launch us from any working directory. The default index is
// always this Atlas installation's .atlas directory, unless explicitly overridden.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
try {
  const [{ createAtlasMcpServer }, { StdioServerTransport }] =
    await Promise.all([
      import("./mcp-server.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
    ]);
  const server = createAtlasMcpServer();
  await server.connect(new StdioServerTransport());
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  console.error(`Atlas MCP: ${error.message}`);
  process.exitCode = 1;
}
