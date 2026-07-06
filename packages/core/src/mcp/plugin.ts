/**
 * MCP Fastify Plugin — exposes the Ion Drive MCP server over Streamable HTTP.
 *
 * Runs in **stateless** mode: each POST spins up a fresh MCP server + transport,
 * handles the single JSON-RPC request, and tears them down when the response
 * closes. There is no session to track, which suits a horizontally-scaled,
 * self-hosted deployment and keeps the transport simple. GET/DELETE (used only
 * for long-lived SSE sessions) are answered with 405.
 *
 * The MCP server instance is rebuilt per request but reads live state from the
 * shared SchemaManager and DataService, so it always reflects the current schema.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyPluginCallback } from 'fastify';
import type { ActionExecutor } from '../blocks/action-executor.js';
import type { DataService } from '../data/data-service.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import { createMcpServer } from './server.js';

export interface McpRoutesOptions {
  schemaManager: SchemaManager;
  dataService: DataService;
  /** When present, installed blocks' actions are exposed as `<block>_<action>` tools (Phase 14). */
  actionExecutor?: ActionExecutor;
}

/** JSON-RPC error returned for unsupported methods in stateless mode. */
const METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; use POST.' },
  id: null,
};

export function registerMcpRoutes(options: McpRoutesOptions): FastifyPluginCallback {
  const { schemaManager, dataService, actionExecutor } = options;

  return (fastify, _opts, done) => {
    fastify.post('/', async (request, reply) => {
      // Declared actions are read per request (like the schema), so tools for
      // newly installed blocks appear without a restart.
      const actions = actionExecutor
        ? { declared: await actionExecutor.listDeclaredActions(), executor: actionExecutor }
        : undefined;
      const server = createMcpServer({ schemaManager, dataService, actions });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // Stateless request/response: return a single JSON body rather than
        // opening an SSE stream, which is simpler for one-shot HTTP clients.
        enableJsonResponse: true,
      });

      // Tear down when the client disconnects or the response finishes.
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        // Hand the raw Node req/res to the transport; Fastify steps aside.
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (err) {
        fastify.log.error({ err }, 'MCP request handling failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          );
        }
      }
    });

    // Stateless mode has no SSE stream or session to resume/terminate.
    fastify.get('/', async (_request, reply) => reply.code(405).send(METHOD_NOT_ALLOWED));
    fastify.delete('/', async (_request, reply) => reply.code(405).send(METHOD_NOT_ALLOWED));

    done();
  };
}
