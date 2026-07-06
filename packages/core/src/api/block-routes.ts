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
import { ActionError, type ActionExecutor } from '../blocks/action-executor.js';
import { type BlockEngine, BlockEngineError } from '../blocks/index.js';

export interface BlockRoutesServices {
  blockEngine: BlockEngine;
  permissionEngine: PermissionEngine;
  /** Runs registered block actions (Phase 14); actions 404 when absent. */
  actionExecutor?: ActionExecutor;
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

/** Maps an ActionError code to an HTTP status + label (shared with hook-routes). */
export const ACTION_ERROR_RESPONSES: Record<
  ActionError['code'],
  { status: number; label: string }
> = {
  not_found: { status: 404, label: 'Not Found' },
  validation: { status: 400, label: 'Validation Error' },
  timeout: { status: 504, label: 'Handler Timeout' },
  failed: { status: 500, label: 'Action Failed' },
};

/** Maps an ActionError to an HTTP status + envelope (shared with hook-routes). */
export function sendActionError(reply: FastifyReply, err: ActionError) {
  const { status, label } = ACTION_ERROR_RESPONSES[err.code];
  return reply.code(status).send({ error: label, message: err.message, issues: err.issues });
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

    // --- List declared actions/hooks + registered handlers (Phase 14) ---
    // Static path, so it resolves ahead of GET /:name. The CLI polls this after
    // vendoring code to know when the dev server has reloaded the new handlers.
    fastify.get('/actions', { preHandler: guard('read') }, async () => {
      const executor = services.actionExecutor;
      return {
        data: {
          declared: executor ? await executor.listDeclaredActions() : [],
          registered: {
            actions: (blockEngine.actionRegistry?.listActions() ?? []).map((a) => ({
              block: a.block,
              name: a.name,
              description: a.description,
            })),
            hooks: (blockEngine.actionRegistry?.listHooks() ?? []).map((h) => ({
              block: h.block,
              name: h.name,
              description: h.description,
            })),
          },
        },
      };
    });

    // --- Invoke a block action (Phase 14) ---
    // Parameterized catch-all: new actions are live the moment their block is
    // installed, no route re-registration (same trick as data-routes). RBAC is
    // resolved per action (manifest override, default `update` on `blocks`).
    fastify.post<{ Params: { block: string; action: string } }>(
      '/:block/actions/:action',
      async (request, reply) => {
        const executor = services.actionExecutor;
        if (!executor) {
          return reply
            .code(404)
            .send({ error: 'Not Found', message: 'Block actions are not enabled on this server' });
        }
        try {
          return await invokeAction(executor, request, reply);
        } catch (err) {
          if (err instanceof ActionError) return sendActionError(reply, err);
          throw err;
        }
      },
    );

    /** Resolves, RBAC-checks (when enforcing), and executes one action invocation. */
    async function invokeAction(
      executor: ActionExecutor,
      request: Parameters<preHandlerHookHandler>[0] & {
        params: { block: string; action: string };
      },
      reply: FastifyReply,
    ) {
      const { definition, rbac } = await executor.resolveAction(
        request.params.block,
        request.params.action,
      );
      if (services.enforce && !(await passesActionRbac(request, reply, rbac))) {
        return reply; // response already sent (401/403)
      }
      const result = await executor.executeAction(definition, request.body, request.auth ?? null);
      return { data: result ?? null };
    }

    /** Enforces the action's resolved RBAC pair; sends 401/403 and returns false on failure. */
    async function passesActionRbac(
      request: Parameters<preHandlerHookHandler>[0],
      reply: FastifyReply,
      rbac: { resource: string; action: Action },
    ): Promise<boolean> {
      if (!request.auth) {
        await reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
        return false;
      }
      const allowed = await permissionEngine.can(request.auth, rbac.action, rbac.resource);
      if (!allowed) {
        await reply.code(403).send({
          error: 'Forbidden',
          message: `Missing permission: ${rbac.action} on "${rbac.resource}"`,
        });
        return false;
      }
      return true;
    }

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
