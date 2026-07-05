/**
 * Building-blocks API — install/list/uninstall domain blocks (Phase 6).
 *
 * Backs the block engine's HTTP surface. A block is submitted as a full,
 * self-contained manifest (the CLI resolves it from a registry and POSTs it
 * here), so the server stays content-agnostic — it validates and applies
 * whatever it is handed, records the ledger, and enforces the dependency graph.
 *
 * Mirrors the task/admin route style: each endpoint is guarded by the `blocks`
 * RBAC resource when enforcement is enabled, and the guard is a no-op otherwise
 * so local dev stays frictionless. {@link BlockEngineError} codes map to HTTP
 * statuses (validation→400, dependency→422, not_found→404, conflict→409,
 * install→500).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';
import { requirePermission } from '../auth/rbac/middleware.js';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { Action } from '../auth/rbac/policy-types.js';
import { PLATFORM_RESOURCES } from '../auth/rbac/policy-types.js';
import { type BlockEngine, BlockEngineError } from '../blocks/index.js';

export interface BlockRoutesServices {
  blockEngine: BlockEngine;
  permissionEngine: PermissionEngine;
  /** When true, endpoints are protected by RBAC permissions. */
  enforce: boolean;
}

const RESOURCE = PLATFORM_RESOURCES.blocks;

/** Maps each BlockEngineError code to an HTTP status + human label. */
const ERROR_RESPONSES: Record<BlockEngineError['code'], { status: number; label: string }> = {
  validation: { status: 400, label: 'Validation Error' },
  dependency: { status: 422, label: 'Unmet Dependency' },
  not_found: { status: 404, label: 'Not Found' },
  conflict: { status: 409, label: 'Conflict' },
  install: { status: 500, label: 'Install Failed' },
};

/** Maps a BlockEngineError to an HTTP status + envelope. */
function sendEngineError(reply: FastifyReply, err: BlockEngineError) {
  const { status, label } = ERROR_RESPONSES[err.code];
  return reply.code(status).send({ error: label, message: err.message, warnings: err.warnings });
}

export function registerBlockRoutes(services: BlockRoutesServices): FastifyPluginCallback {
  const { blockEngine, permissionEngine } = services;

  const guard = (action: Action): preHandlerHookHandler => {
    if (!services.enforce) return (_req, _reply, done) => done();
    return requirePermission(permissionEngine, action, RESOURCE);
  };

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // --- List installed blocks ---
    fastify.get('/', { preHandler: guard('read') }, async () => ({
      data: await blockEngine.listInstalled(),
    }));

    // --- Preview an install (dry run; static path resolves ahead of /:name) ---
    fastify.post('/preview', { preHandler: guard('read') }, async (request, reply) => {
      try {
        return {
          data: await blockEngine.preview(
            (request.body as { manifest?: unknown })?.manifest ?? request.body,
          ),
        };
      } catch (err) {
        if (err instanceof BlockEngineError) return sendEngineError(reply, err);
        throw err;
      }
    });

    // --- Install a block from a submitted manifest ---
    fastify.post<{ Querystring: { dryRun?: string; force?: string } }>(
      '/install',
      { preHandler: guard('manage') },
      async (request, reply) => {
        const body = request.body as { manifest?: unknown };
        const manifest = body?.manifest ?? request.body;
        const dryRun = request.query.dryRun === 'true' || request.query.dryRun === '1';
        const force = request.query.force === 'true' || request.query.force === '1';
        try {
          const report = await blockEngine.install(manifest, { dryRun, force });
          return reply.code(dryRun ? 200 : 201).send({ data: report });
        } catch (err) {
          if (err instanceof BlockEngineError) return sendEngineError(reply, err);
          throw err;
        }
      },
    );

    // --- Get one installed block ---
    fastify.get<{ Params: { name: string } }>(
      '/:name',
      { preHandler: guard('read') },
      async (request, reply) => {
        const block = await blockEngine.getInstalled(request.params.name);
        if (!block)
          return reply.code(404).send({ error: 'Not Found', message: 'Block not installed' });
        return { data: block };
      },
    );

    // --- Uninstall a block ---
    fastify.delete<{ Params: { name: string }; Querystring: { dropData?: string } }>(
      '/:name',
      { preHandler: guard('manage') },
      async (request, reply) => {
        const dropData = request.query.dropData === 'true' || request.query.dropData === '1';
        try {
          const result = await blockEngine.uninstall(request.params.name, { dropData });
          return reply.code(200).send({ data: result });
        } catch (err) {
          if (err instanceof BlockEngineError) return sendEngineError(reply, err);
          throw err;
        }
      },
    );

    done();
  };
}
