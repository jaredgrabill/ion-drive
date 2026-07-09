/**
 * `ion-drive mcp` — serve the registry MCP tools over stdio (spec-08 §4).
 *
 * A coding agent adds this as a stdio MCP server to discover and preview
 * blocks (`search_blocks` / `get_block` / `list_registries` /
 * `preview_install`); the *platform's* MCP surface at `/api/v1/mcp` then
 * works with the installed data. **STDOUT purity is the contract:** stdout
 * carries only the MCP protocol — no banner, no spinner, no logging. Any
 * diagnostics go to stderr (and `readConfig`'s once-per-process warnings
 * already use `console.warn` = stderr).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRegistryMcpServer } from '../mcp/server.js';

export async function mcpCommand(): Promise<void> {
  const server = createRegistryMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport owns stdin/stdout from here; the process exits when the
  // client disconnects (stdin closes).
}
