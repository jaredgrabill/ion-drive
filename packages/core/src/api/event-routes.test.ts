/**
 * Phase 12 (ADR-019): the event operations surface — list validation, DLQ
 * filters, and the retry action's revive-and-wake contract.
 */

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { EventStore } from '../messaging/event-store.js';
import type { MessageBus } from '../messaging/message-bus.js';
import { registerEventRoutes } from './event-routes.js';

function build(overrides: { reset?: boolean } = {}) {
  const eventStore = {
    listEvents: vi.fn(async () => ({ data: [], totalCount: 0 })),
    listDeliveries: vi.fn(async () => ({ data: [], totalCount: 0 })),
    resetDelivery: vi.fn(async () => overrides.reset ?? true),
  } as unknown as EventStore;
  const bus = { wake: vi.fn() } as unknown as MessageBus;
  const app = Fastify();
  app.register(
    registerEventRoutes({
      eventStore,
      bus,
      permissionEngine: {} as PermissionEngine,
      enforce: false,
      maxAttempts: 5,
    }),
    { prefix: '/api/v1/events' },
  );
  return { app, eventStore, bus };
}

describe('event routes', () => {
  it('lists deliveries with the DLQ (dead) filter and passes maxAttempts through', async () => {
    const { app, eventStore } = build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/events/deliveries?dead=true&status=failed&limit=10',
    });
    expect(res.statusCode).toBe(200);
    expect(eventStore.listDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({ dead: true, status: 'failed', maxAttempts: 5, limit: 10 }),
    );
  });

  it('rejects an invalid status filter', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/events/deliveries?status=nope' });
    expect(res.statusCode).toBe(400);
  });

  it('retry revives the delivery and wakes the dispatcher', async () => {
    const { app, eventStore, bus } = build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/deliveries/retry',
      payload: { eventId: '7f1e0d9c-3c1e-4e5f-9a1b-2c3d4e5f6a7b', consumer: 'audit' },
    });
    expect(res.statusCode).toBe(202);
    expect(eventStore.resetDelivery).toHaveBeenCalledWith(
      '7f1e0d9c-3c1e-4e5f-9a1b-2c3d4e5f6a7b',
      'audit',
    );
    expect(bus.wake).toHaveBeenCalled();
  });

  it('retry of an unknown delivery is a 404 and does not wake', async () => {
    const { app, bus } = build({ reset: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/deliveries/retry',
      payload: { eventId: '7f1e0d9c-3c1e-4e5f-9a1b-2c3d4e5f6a7b', consumer: 'audit' },
    });
    expect(res.statusCode).toBe(404);
    expect(bus.wake).not.toHaveBeenCalled();
  });

  it('validates the retry body (eventId must be a uuid)', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/deliveries/retry',
      payload: { eventId: 'not-a-uuid', consumer: 'audit' },
    });
    expect(res.statusCode).toBe(400);
  });
});
