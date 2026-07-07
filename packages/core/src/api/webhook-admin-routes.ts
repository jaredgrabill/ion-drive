/**
 * Webhook management API (Phase 12 / ADR-019) — CRUD for outbound webhooks at
 * `/api/v1/webhooks`, RBAC resource `webhooks`, self-guarding like the task
 * and admin routes. The signing secret is returned exactly once, on create
 * (API-key style); list/get responses never carry secret material. Delivery
 * history lives in the shared ledger — point the DLQ surface at
 * `consumer=webhook:<id>`.
 */

import type { FastifyInstance, FastifyPluginCallback, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/rbac/middleware.js';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { Action } from '../auth/rbac/policy-types.js';
import { PLATFORM_RESOURCES } from '../auth/rbac/policy-types.js';
import { WebhookError, type WebhookManager } from '../messaging/webhooks.js';

export interface WebhookRoutesServices {
  webhookManager: WebhookManager;
  permissionEngine: PermissionEngine;
  /** When true, endpoints are protected by RBAC permissions. */
  enforce: boolean;
}

const RESOURCE = PLATFORM_RESOURCES.webhooks;

const topicPattern = z.string().min(1).max(255);

const webhookInputSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().max(2000),
  topics: z.array(topicPattern).min(1).max(50),
  headers: z.record(z.string().max(4000)).optional(),
  enabled: z.boolean().optional(),
});

export function registerWebhookRoutes(services: WebhookRoutesServices): FastifyPluginCallback {
  const { webhookManager, permissionEngine } = services;

  const guard = (action: Action): preHandlerHookHandler => {
    if (!services.enforce) return (_req, _reply, done) => done();
    return requirePermission(permissionEngine, action, RESOURCE);
  };

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // --- List --------------------------------------------------------
    fastify.get('/', { preHandler: guard('read') }, async () => ({
      data: await webhookManager.list(),
    }));

    // --- Create (returns the signing secret exactly once) -------------
    fastify.post('/', { preHandler: guard('manage') }, async (request, reply) => {
      const parsed = webhookInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
      }
      try {
        const created = await webhookManager.create(parsed.data);
        return reply.code(201).send({ data: { ...created.webhook, secret: created.secret } });
      } catch (err) {
        if (err instanceof WebhookError && err.code === 'conflict') {
          return reply.code(409).send({ error: 'Conflict', message: err.message });
        }
        throw err;
      }
    });

    // --- Get one -------------------------------------------------------
    fastify.get<{ Params: { id: string } }>(
      '/:id',
      { preHandler: guard('read') },
      async (request, reply) => {
        const webhook = await webhookManager.getById(request.params.id);
        if (!webhook) {
          return reply.code(404).send({ error: 'Not Found', message: 'Webhook not found' });
        }
        return { data: webhook };
      },
    );

    // --- Update --------------------------------------------------------
    fastify.patch<{ Params: { id: string } }>(
      '/:id',
      { preHandler: guard('manage') },
      async (request, reply) => {
        const parsed = webhookInputSchema.partial().safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
        }
        const webhook = await webhookManager.update(request.params.id, parsed.data);
        if (!webhook) {
          return reply.code(404).send({ error: 'Not Found', message: 'Webhook not found' });
        }
        return { data: webhook };
      },
    );

    // --- Delete --------------------------------------------------------
    fastify.delete<{ Params: { id: string } }>(
      '/:id',
      { preHandler: guard('manage') },
      async (request, reply) => {
        const removed = await webhookManager.remove(request.params.id);
        if (!removed) {
          return reply.code(404).send({ error: 'Not Found', message: 'Webhook not found' });
        }
        return reply.code(204).send();
      },
    );

    // --- Fire a test delivery -------------------------------------------
    fastify.post<{ Params: { id: string } }>(
      '/:id/test',
      { preHandler: guard('manage') },
      async (request, reply) => {
        const sent = await webhookManager.sendTest(request.params.id);
        if (!sent) {
          return reply
            .code(404)
            .send({ error: 'Not Found', message: 'Webhook not found or disabled' });
        }
        return reply.code(202).send({ data: { queued: true } });
      },
    );

    done();
  };
}
