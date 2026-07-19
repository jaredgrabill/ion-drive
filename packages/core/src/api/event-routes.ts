/**
 * Event operations API (Phase 12 / ADR-019) — the outbox and its delivery
 * ledger get an operational surface:
 *
 *  - `GET /api/v1/events` — browse recent outbox events (topic filter, paging).
 *  - `GET /api/v1/events/deliveries` — the delivery ledger joined to events
 *    (status/consumer filters; `dead=true` narrows to deliveries whose retry
 *    budget is exhausted — the DLQ view).
 *  - `POST /api/v1/events/deliveries/retry` — revives one delivery (resets its
 *    attempt budget) and nudges the dispatcher, so it redelivers immediately.
 *  - `GET /api/v1/events/stream` — realtime SSE subscription (see
 *    `messaging/realtime.ts`), RBAC-filtered per event.
 *
 * Mirrors the task/admin-routes style: guarded by the `events` RBAC resource
 * when enforcement is enabled, no-op guards otherwise. Registered only when
 * `ION_EVENTS_ENABLED` is on (like the dispatcher itself).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/rbac/middleware.js';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { Action } from '../auth/rbac/policy-types.js';
import { PLATFORM_RESOURCES } from '../auth/rbac/policy-types.js';
import type { RowPolicyResolver } from '../auth/rbac/row-policy.js';
import { createEventAccessFilter } from '../messaging/event-access.js';
import type { EventStore } from '../messaging/event-store.js';
import type { MessageBus } from '../messaging/message-bus.js';
import type { RealtimeBridge } from '../messaging/realtime.js';

export interface EventRoutesServices {
  eventStore: EventStore;
  /** Used to nudge the dispatcher after a retry (its wake signal). */
  bus: MessageBus;
  permissionEngine: PermissionEngine;
  /** When true, endpoints are protected by RBAC permissions. */
  enforce: boolean;
  /** The dispatcher's retry budget — also the DLQ ("dead") threshold. */
  maxAttempts: number;
  /** Present when realtime streaming is available (outbox bus only). */
  realtime?: RealtimeBridge;
  /** Row-level read scoping for streamed data events (issue #7). */
  rowPolicies?: RowPolicyResolver;
}

const RESOURCE = PLATFORM_RESOURCES.events;

const listQuerySchema = z.object({
  topic: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const deliveriesQuerySchema = listQuerySchema.extend({
  status: z.enum(['pending', 'done', 'failed']).optional(),
  consumer: z.string().max(255).optional(),
  dead: z.coerce.boolean().default(false),
});

const retryBodySchema = z.object({
  eventId: z.string().uuid(),
  consumer: z.string().min(1).max(255),
});

export function registerEventRoutes(services: EventRoutesServices): FastifyPluginCallback {
  const { eventStore, bus, permissionEngine } = services;

  const guard = (action: Action): preHandlerHookHandler => {
    if (!services.enforce) return (_req, _reply, done) => done();
    return requirePermission(permissionEngine, action, RESOURCE);
  };

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // --- Recent outbox events -----------------------------------------
    fastify.get('/', { preHandler: guard('read') }, async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
      }
      const { topic, limit, offset } = parsed.data;
      const result = await eventStore.listEvents({ topicPrefix: topic, limit, offset });
      return { data: result.data, totalCount: result.totalCount };
    });

    // --- Delivery ledger / DLQ view -----------------------------------
    fastify.get('/deliveries', { preHandler: guard('read') }, async (request, reply) => {
      const parsed = deliveriesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
      }
      const { status, consumer, dead, limit, offset } = parsed.data;
      const result = await eventStore.listDeliveries({
        status,
        consumer,
        dead,
        maxAttempts: services.maxAttempts,
        limit,
        offset,
      });
      return { data: result.data, totalCount: result.totalCount };
    });

    // --- Retry one delivery -------------------------------------------
    fastify.post('/deliveries/retry', { preHandler: guard('manage') }, async (request, reply) => {
      const parsed = retryBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
      }
      const revived = await eventStore.resetDelivery(parsed.data.eventId, parsed.data.consumer);
      if (!revived) {
        return reply.code(404).send({ error: 'Not Found', message: 'Delivery not found' });
      }
      bus.wake();
      return reply.code(202).send({ data: { retried: true } });
    });

    // --- Realtime stream (Phase 12 Tier 4) ----------------------------
    if (services.realtime) {
      installStreamRoute(
        fastify,
        services.realtime,
        services.enforce,
        permissionEngine,
        services.rowPolicies,
      );
    }

    done();
  };
}

/** Interval between SSE comment heartbeats (keeps proxies from idling out). */
const SSE_HEARTBEAT_MS = 15_000;

/**
 * `GET /stream?topics=data.contacts.*,data.orders.created` — bridges the
 * outbox to Server-Sent Events. Delivery is best-effort from connect time
 * (no replay); each event is RBAC-filtered for the connected principal:
 * `data.<object>.*` requires `read` on the object, anything else `read` on
 * `events`. The connection itself requires authentication when enforcement
 * is on (anonymous connections would see nothing anyway).
 */
function installStreamRoute(
  fastify: FastifyInstance,
  realtime: RealtimeBridge,
  enforce: boolean,
  permissionEngine: PermissionEngine,
  rowPolicies?: RowPolicyResolver,
): void {
  fastify.get('/stream', (request: FastifyRequest, reply) => {
    if (enforce && !request.auth) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }
    const topicsRaw = (request.query as { topics?: string }).topics;
    const topics = (topicsRaw ?? 'data.#')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    reply.hijack();
    const socket = reply.raw;
    socket.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    socket.write('retry: 3000\n\n');

    // Per-connection RBAC filter with a cached verdict per distinct resource
    // (shared with GraphQL subscriptions — see messaging/event-access.ts).
    const allowed = createEventAccessFilter({
      enforce,
      permissionEngine,
      auth: request.auth ?? null,
      fallbackResource: RESOURCE,
      rowPolicies,
    });

    // Frames are unnamed (no `event:` line) so plain `EventSource.onmessage`
    // works; the envelope's own `topic` field identifies the event.
    const unsubscribe = realtime.subscribe(topics, async (event) => {
      if (!(await allowed(event.topic, event))) return;
      socket.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      socket.write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
