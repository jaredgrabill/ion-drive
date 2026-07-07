/**
 * Phase 12 (ADR-019): outbound webhooks — signing, bus projection, delivery.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Encryptor } from '../config/encryption.js';
import type { LoggerProvider } from '../logging/logger-provider.js';
import type { EventContext, IonEvent } from './event-types.js';
import { OutboxBus } from './outbox-bus.js';
import {
  WEBHOOK_HANDLER_NAME,
  WEBHOOK_SIGNATURE_HEADER,
  WebhookManager,
  type WebhookRow,
  type WebhookStore,
  generateWebhookSecret,
  signWebhookPayload,
} from './webhooks.js';

const logger: LoggerProvider = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
};

const encryptor = new Encryptor('test-master-key');

/** In-memory WebhookStore double. */
function fakeStore(initial: WebhookRow[] = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    rows,
    store: {
      list: async () => [...rows.values()],
      getById: async (id: string) => rows.get(id) ?? null,
      getByName: async (name: string) => [...rows.values()].find((r) => r.name === name) ?? null,
      insert: async (input: WebhookRow & { secretEncrypted: string }) => {
        const row: WebhookRow = {
          ...input,
          topics: input.topics,
          headers: input.headers ?? {},
          enabled: input.enabled ?? true,
          managedBy: input.managedBy ?? 'user',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(row.id, row);
        return row;
      },
      update: async (id: string, patch: Partial<WebhookRow>) => {
        const row = rows.get(id);
        if (!row) return null;
        const updated = { ...row, ...patch, updatedAt: new Date() };
        rows.set(id, updated);
        return updated;
      },
      remove: async (id: string) => rows.delete(id),
      removeByManagedBy: async (managedBy: string) => {
        const ids = [...rows.values()].filter((r) => r.managedBy === managedBy).map((r) => r.id);
        for (const id of ids) rows.delete(id);
        return ids;
      },
    } as unknown as WebhookStore,
  };
}

function fakeBus() {
  const store = { insert: vi.fn(async () => {}) };
  // biome-ignore lint/suspicious/noExplicitAny: minimal double
  return new OutboxBus(store as any);
}

describe('webhook signing', () => {
  it('produces a Stripe-style t=,v1= signature over "<t>.<body>"', () => {
    const secret = 'whsec_abc';
    const signature = signWebhookPayload(secret, '{"a":1}', 1700000000);
    const expected = createHmac('sha256', secret).update('1700000000.{"a":1}').digest('hex');
    expect(signature).toBe(`t=1700000000,v1=${expected}`);
  });

  it('generates whsec_-prefixed secrets with fresh entropy', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe('WebhookManager', () => {
  it('create stores an encrypted secret, returns it once, and subscribes the bus', async () => {
    const { store } = fakeStore();
    const bus = fakeBus();
    const manager = new WebhookManager({ store, bus, encryptor, logger });
    await manager.initialize();

    const created = await manager.create({
      name: 'crm-sync',
      url: 'https://example.com/hook',
      topics: ['data.contacts.*', 'data.companies.created'],
    });

    expect(created.secret).toMatch(/^whsec_/);
    // Never echoed by the view:
    expect(created.webhook).not.toHaveProperty('secretEncrypted');
    expect(created.webhook).not.toHaveProperty('secret');

    const subs = bus.listSubscriptions();
    const consumer = `webhook:${created.webhook.id}`;
    expect(subs.filter((s) => s.consumer === consumer)).toHaveLength(3); // 2 topics + test topic
    expect(subs.every((s) => s.handler === WEBHOOK_HANDLER_NAME)).toBe(true);
  });

  it('rejects a duplicate name with a conflict error', async () => {
    const { store } = fakeStore();
    const manager = new WebhookManager({ store, bus: fakeBus(), encryptor, logger });
    await manager.create({ name: 'dup', url: 'https://x.test', topics: ['data.#'] });
    await expect(
      manager.create({ name: 'dup', url: 'https://y.test', topics: ['data.#'] }),
    ).rejects.toThrow('already exists');
  });

  it('disabling via update unsubscribes; deleting removes the consumer', async () => {
    const { store } = fakeStore();
    const bus = fakeBus();
    const manager = new WebhookManager({ store, bus, encryptor, logger });
    const { webhook } = await manager.create({
      name: 'w',
      url: 'https://x.test',
      topics: ['data.#'],
    });

    await manager.update(webhook.id, { enabled: false });
    expect(bus.listSubscriptions().filter((s) => s.consumer === `webhook:${webhook.id}`)).toEqual(
      [],
    );

    await manager.update(webhook.id, { enabled: true });
    expect(
      bus.listSubscriptions().filter((s) => s.consumer === `webhook:${webhook.id}`),
    ).toHaveLength(2);

    await manager.remove(webhook.id);
    expect(bus.listSubscriptions().filter((s) => s.consumer === `webhook:${webhook.id}`)).toEqual(
      [],
    );
  });

  it('the webhook handler POSTs the signed envelope and throws on non-2xx', async () => {
    const { store } = fakeStore();
    const bus = fakeBus();
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const manager = new WebhookManager({ store, bus, encryptor, logger, fetchImpl });
    await manager.initialize();
    const created = await manager.create({
      name: 'w',
      url: 'https://receiver.test/hook',
      topics: ['data.#'],
      headers: { 'x-custom': 'yes' },
    });

    const handler = bus.getHandler(WEBHOOK_HANDLER_NAME);
    const event: IonEvent = {
      id: 'e1',
      topic: 'data.contacts.created',
      payload: { object: 'contacts', id: 'r1' },
      occurredAt: new Date(),
    };
    const ctx: EventContext = {
      event,
      subscription: {
        topic: 'data.#',
        consumer: `webhook:${created.webhook.id}`,
        handler: WEBHOOK_HANDLER_NAME,
        config: { webhookId: created.webhook.id },
      },
      signal: new AbortController().signal,
      logger,
    };
    await handler?.handle(ctx);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://receiver.test/hook');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-custom']).toBe('yes');
    expect(headers['x-ion-topic']).toBe('data.contacts.created');
    // Signature verifies against the sent body with the once-returned secret.
    const sig = headers[WEBHOOK_SIGNATURE_HEADER];
    const t = Number(/t=(\d+)/.exec(sig)?.[1]);
    expect(signWebhookPayload(created.secret, String(init.body), t)).toBe(sig);

    // Non-2xx → throws so the ledger records a failed (retryable) delivery.
    fetchImpl.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(handler?.handle(ctx)).rejects.toThrow('Webhook responded 500');
  });

  it('deliveries to deleted or disabled webhooks are dropped silently', async () => {
    const { store } = fakeStore();
    const bus = fakeBus();
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const manager = new WebhookManager({ store, bus, encryptor, logger, fetchImpl });
    await manager.initialize();
    const handler = bus.getHandler(WEBHOOK_HANDLER_NAME);

    const ctx = {
      event: { id: 'e1', topic: 't', payload: {}, occurredAt: new Date() },
      subscription: {
        topic: 't',
        consumer: 'webhook:gone',
        handler: WEBHOOK_HANDLER_NAME,
        config: { webhookId: 'gone' },
      },
      signal: new AbortController().signal,
      logger,
    } as EventContext;

    await expect(handler?.handle(ctx)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removeByManagedBy unsubscribes every block-owned webhook (uninstall path)', async () => {
    const { store } = fakeStore();
    const bus = fakeBus();
    const manager = new WebhookManager({ store, bus, encryptor, logger });
    const a = await manager.create({
      name: 'a',
      url: 'https://x.test',
      topics: ['data.#'],
      managedBy: 'block:crm',
    });
    await manager.create({ name: 'b', url: 'https://y.test', topics: ['data.#'] });

    const removed = await manager.removeByManagedBy('block:crm');

    expect(removed).toBe(1);
    expect(bus.listSubscriptions().some((s) => s.consumer === `webhook:${a.webhook.id}`)).toBe(
      false,
    );
    expect(await manager.list()).toHaveLength(1);
  });
});
