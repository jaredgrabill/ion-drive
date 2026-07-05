/**
 * Task management API — scheduled/background tasks (Phase 5).
 *
 * Backs the task engine's HTTP surface: list/create/update/delete task
 * definitions, list registered handler types, browse run history, and trigger a
 * run on demand. Mirrors the admin-routes style: each mutating endpoint is
 * guarded by the `tasks` RBAC resource when enforcement is enabled, and the
 * guard is a no-op otherwise so local dev stays frictionless.
 *
 * {@link TaskEngineError} codes are mapped to HTTP statuses (validation→400,
 * not_found→404, conflict→409).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/rbac/middleware.js';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { Action } from '../auth/rbac/policy-types.js';
import { PLATFORM_RESOURCES } from '../auth/rbac/policy-types.js';
import { type TaskEngine, TaskEngineError } from '../tasks/index.js';

export interface TaskRoutesServices {
  taskEngine: TaskEngine;
  permissionEngine: PermissionEngine;
  /** When true, endpoints are protected by RBAC permissions. */
  enforce: boolean;
}

const taskInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullish(),
  type: z.string().min(1).max(64),
  schedule: z.string().max(255).nullish(),
  timezone: z.string().max(64).nullish(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const RESOURCE = PLATFORM_RESOURCES.tasks;

/** Maps a TaskEngineError to an HTTP status + envelope. */
function sendEngineError(reply: FastifyReply, err: TaskEngineError) {
  const status = err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400;
  const label =
    err.code === 'not_found'
      ? 'Not Found'
      : err.code === 'conflict'
        ? 'Conflict'
        : 'Validation Error';
  return reply.code(status).send({ error: label, message: err.message });
}

export function registerTaskRoutes(services: TaskRoutesServices): FastifyPluginCallback {
  const { taskEngine, permissionEngine } = services;

  const guard = (action: Action): preHandlerHookHandler => {
    if (!services.enforce) return (_req, _reply, done) => done();
    return requirePermission(permissionEngine, action, RESOURCE);
  };

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // --- Registered handler types (static path resolves ahead of /:id) ---
    fastify.get('/handlers', { preHandler: guard('read') }, async () => ({
      data: taskEngine.listHandlers(),
    }));

    // --- List tasks ---
    fastify.get('/', { preHandler: guard('read') }, async () => ({
      data: await taskEngine.list(),
    }));

    // --- Create task ---
    fastify.post('/', { preHandler: guard('manage') }, async (request, reply) => {
      const parsed = taskInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
      }
      try {
        const task = await taskEngine.create({
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          type: parsed.data.type,
          schedule: parsed.data.schedule ?? null,
          timezone: parsed.data.timezone ?? null,
          enabled: parsed.data.enabled,
          config: parsed.data.config,
        });
        return reply.code(201).send({ data: task });
      } catch (err) {
        if (err instanceof TaskEngineError) return sendEngineError(reply, err);
        throw err;
      }
    });

    // --- Get one task (with recent runs + next scheduled fire) ---
    fastify.get<{ Params: { id: string } }>(
      '/:id',
      { preHandler: guard('read') },
      async (request, reply) => {
        const task = await taskEngine.getWithRuns(request.params.id);
        if (!task) return reply.code(404).send({ error: 'Not Found', message: 'Task not found' });
        return { data: task };
      },
    );

    // --- Update task ---
    fastify.patch<{ Params: { id: string } }>(
      '/:id',
      { preHandler: guard('manage') },
      async (request, reply) => {
        const parsed = taskInputSchema.partial().safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
        }
        try {
          const task = await taskEngine.update(request.params.id, {
            name: parsed.data.name,
            description: parsed.data.description,
            type: parsed.data.type,
            schedule: parsed.data.schedule,
            timezone: parsed.data.timezone,
            enabled: parsed.data.enabled,
            config: parsed.data.config,
          });
          return { data: task };
        } catch (err) {
          if (err instanceof TaskEngineError) return sendEngineError(reply, err);
          throw err;
        }
      },
    );

    // --- Delete task ---
    fastify.delete<{ Params: { id: string } }>(
      '/:id',
      { preHandler: guard('manage') },
      async (request, reply) => {
        try {
          await taskEngine.remove(request.params.id);
          return reply.code(204).send();
        } catch (err) {
          if (err instanceof TaskEngineError) return sendEngineError(reply, err);
          throw err;
        }
      },
    );

    // --- Run a task now ---
    fastify.post<{ Params: { id: string } }>(
      '/:id/run',
      { preHandler: guard('manage') },
      async (request, reply) => {
        try {
          const run = await taskEngine.runNow(request.params.id, 'manual');
          return reply.code(202).send({ data: run });
        } catch (err) {
          if (err instanceof TaskEngineError) return sendEngineError(reply, err);
          throw err;
        }
      },
    );

    // --- Run history ---
    fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
      '/:id/runs',
      { preHandler: guard('read') },
      async (request, reply) => {
        const task = await taskEngine.getById(request.params.id);
        if (!task) return reply.code(404).send({ error: 'Not Found', message: 'Task not found' });
        const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
        return { data: await taskEngine.listRuns(request.params.id, limit) };
      },
    );

    done();
  };
}
