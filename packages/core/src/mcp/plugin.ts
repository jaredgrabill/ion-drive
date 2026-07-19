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
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { ActionExecutor } from '../blocks/action-executor.js';
import type { InstalledBlock } from '../blocks/block-types.js';
import type { DataService } from '../data/data-service.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import { createMcpServer } from './server.js';

export interface McpRoutesOptions {
  schemaManager: SchemaManager;
  dataService: DataService;
  /** When present, installed blocks' actions are exposed as `<block>_<action>` tools (Phase 14). */
  actionExecutor?: ActionExecutor;
  /** When present, the `list_blocks` ledger tool is exposed (spec-04 parity). */
  blockEngine?: { listInstalled: () => Promise<InstalledBlock[]> };
  /**
   * Required for anonymous public-read mode (issue #8): with `enforce` on,
   * an unauthenticated POST gets a stripped-down server exposing only the
   * per-object-gated read data tools instead of the full tool surface.
   */
  permissionEngine?: PermissionEngine;
  /** Whether RBAC is enforced (config.requireAuth). */
  enforce?: boolean;
}

/** JSON-RPC error returned for unsupported methods in stateless mode. */
const METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; use POST.' },
  id: null,
};

export function registerMcpRoutes(options: McpRoutesOptions): FastifyPluginCallback {
  const { schemaManager, dataService, actionExecutor, blockEngine, permissionEngine } = options;

  return (fastify, _opts, done) => {
    fastify.post('/', async (request, reply) => {
      // Anonymous public-read mode (issue #8): under enforcement, a request
      // with no credential reaches this handler only when public read grants
      // exist (see rbac/enforcement.ts). It gets a server exposing solely the
      // read data tools, each gated per object through the public role.
      const anonymous = Boolean(options.enforce) && !request.auth && permissionEngine;
      if (anonymous && permissionEngine) {
        const server = createMcpServer({
          schemaManager,
          dataService,
          publicRead: { canRead: (objectName) => permissionEngine.can(null, 'read', objectName) },
        });
        return handleMcpRequest(fastify, server, request, reply);
      }

      // Declared actions are read per request (like the schema), so tools for
      // newly installed blocks appear without a restart.
      const actions = actionExecutor
        ? { declared: await actionExecutor.listDeclaredActions(), executor: actionExecutor }
        : undefined;
      const blocks = blockEngine ? { listInstalled: () => blockEngine.listInstalled() } : undefined;
      const server = createMcpServer({ schemaManager, dataService, actions, blocks });
      return handleMcpRequest(fastify, server, request, reply);
    });

    // Stateless mode has no SSE stream or session to resume/terminate.
    fastify.get('/', async (_request, reply) => reply.code(405).send(METHOD_NOT_ALLOWED));
    fastify.delete('/', async (_request, reply) => reply.code(405).send(METHOD_NOT_ALLOWED));

    done();
  };
}

/**
 * Runs one stateless JSON-RPC exchange through a fresh transport: connect,
 * hijack the raw response, hand it to the transport, tear down on close.
 * Shared by the full server and the anonymous public-read server.
 */
async function handleMcpRequest(
  fastify: FastifyInstance,
  server: ReturnType<typeof createMcpServer>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
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
}
