/**
 * Unit tests for the Redis Streams bus + dispatcher over the in-memory fake:
 * delivery, topic filtering, cross-instance consumer-group arbitration,
 * exponential-backoff retries, dead-lettering, and per-instance groups.
 */

import type { IonEvent, LoggerProvider } from '@ion-drive/core';
import { describe, expect, it } from 'vitest';
import { FakeRedis } from './fake-redis.js';
import { RedisDispatcher } from './redis-dispatcher.js';
import { RedisStreamsBus, eventFromFields, eventToFields } from './streams-bus.js';

const noopLogger: LoggerProvider = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function rig(options?: { maxAttempts?: number; instanceId?: string; redis?: FakeRedis }) {
  const redis = options?.redis ?? new FakeRedis();
  const bus = new RedisStreamsBus(redis, { keyPrefix: 'ion:' });
  const dispatcher = new RedisDispatcher(redis, bus, {
    logger: noopLogger,
    maxAttempts: options?.maxAttempts,
    instanceId: options?.instanceId ?? 'inst-1',
  });
  return { redis, bus, dispatcher };
}

describe('event field serialization', () => {
  it('round-trips an envelope', () => {
    const event: IonEvent<unknown> = {
      id: 'e1',
      topic: 'data.contacts.created',
      payload: { object: 'contacts', id: 'r1' },
      occurredAt: new Date('2026-07-07T12:00:00Z'),
    };
    expect(eventFromFields(eventToFields(event))).toEqual(event);
  });

  it('returns undefined for malformed fields', () => {
    expect(eventFromFields({ id: 'x' })).toBeUndefined();
    expect(
      eventFromFields({ id: 'x', topic: 't', payload: '{bad', occurredAt: 'now' }),
    ).toBeUndefined();
  });
});

describe('RedisDispatcher', () => {
  it('delivers a published event once to a matching subscription', async () => {
    const { bus, dispatcher } = rig();
    const seen: IonEvent<unknown>[] = [];
    bus.on('data.contacts.*', 'test-group', (event) => {
      seen.push(event);
    });
    // Group must exist before publish ('$' start) — the first drain creates it.
    await dispatcher.runPending();

    await bus.publish({ topic: 'data.contacts.created', payload: { id: 1 } });
    await dispatcher.runPending();
    await dispatcher.runPending(); // idempotent — already acked

    expect(seen).toHaveLength(1);
    expect(seen[0]?.topic).toBe('data.contacts.created');
    expect(seen[0]?.payload).toEqual({ id: 1 });
  });

  it('acks non-matching topics without invoking the handler', async () => {
    const { redis, bus, dispatcher } = rig();
    let calls = 0;
    bus.on('data.invoices.*', 'inv-group', () => {
      calls += 1;
    });
    await dispatcher.runPending();
    await bus.publish({ topic: 'data.contacts.created', payload: {} });
    await dispatcher.runPending();

    expect(calls).toBe(0);
    expect(await redis.pending('ion:events', 'inv-group', 10)).toHaveLength(0);
  });

  it('delivers once per consumer group across instances', async () => {
    const redis = new FakeRedis();
    const a = rig({ redis, instanceId: 'inst-a' });
    // Second dispatcher shares the bus (subscriptions/handlers) but its own id.
    const b = new RedisDispatcher(redis, a.bus, { logger: noopLogger, instanceId: 'inst-b' });

    let calls = 0;
    a.bus.on('data.#', 'shared-group', () => {
      calls += 1;
    });
    await a.dispatcher.runPending();
    await a.bus.publish({ topic: 'data.x.created', payload: {} });

    await a.dispatcher.runPending();
    await b.runPending();
    expect(calls).toBe(1);
  });

  it('delivers per instance when the subscription asks for it', async () => {
    const redis = new FakeRedis();
    const a = rig({ redis, instanceId: 'inst-a' });
    const b = new RedisDispatcher(redis, a.bus, { logger: noopLogger, instanceId: 'inst-b' });

    let calls = 0;
    a.bus.on(
      'data.#',
      'fanout-group',
      () => {
        calls += 1;
      },
      { perInstance: true },
    );
    await a.dispatcher.runPending();
    await b.runPending();
    await a.bus.publish({ topic: 'data.x.created', payload: {} });

    await a.dispatcher.runPending();
    await b.runPending();
    expect(calls).toBe(2);
  });

  it('retries a failed delivery only after the backoff elapses', async () => {
    const { redis, bus, dispatcher } = rig();
    let attempts = 0;
    bus.on('data.#', 'retry-group', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
    });
    await dispatcher.runPending();
    await bus.publish({ topic: 'data.x.created', payload: {} });

    await dispatcher.runPending(); // attempt 1 fails, stays pending
    expect(attempts).toBe(1);

    await dispatcher.runPending(); // backoff (5s) not elapsed — no retry
    expect(attempts).toBe(1);

    redis.advance(5001);
    await dispatcher.runPending(); // attempt 2 succeeds
    expect(attempts).toBe(2);
    expect(await redis.pending('ion:events', 'retry-group', 10)).toHaveLength(0);
  });

  it('doubles the backoff per failed attempt', async () => {
    const { redis, bus, dispatcher } = rig({ maxAttempts: 5 });
    let attempts = 0;
    bus.on('data.#', 'backoff-group', () => {
      attempts += 1;
      throw new Error('always');
    });
    await dispatcher.runPending();
    await bus.publish({ topic: 'data.x.created', payload: {} });

    await dispatcher.runPending();
    expect(attempts).toBe(1);

    redis.advance(5001); // attempt 2 due after 5s
    await dispatcher.runPending();
    expect(attempts).toBe(2);

    redis.advance(5001); // attempt 3 needs 10s — not due yet
    await dispatcher.runPending();
    expect(attempts).toBe(2);

    redis.advance(5000);
    await dispatcher.runPending();
    expect(attempts).toBe(3);
  });

  it('dead-letters an event after the retry budget', async () => {
    const { redis, bus, dispatcher } = rig({ maxAttempts: 2 });
    let attempts = 0;
    bus.on('data.#', 'dlq-group', () => {
      attempts += 1;
      throw new Error('always fails');
    });
    await dispatcher.runPending();
    await bus.publish({ topic: 'data.x.created', payload: { n: 1 } });

    await dispatcher.runPending(); // attempt 1
    redis.advance(5001);
    await dispatcher.runPending(); // attempt 2 → exhausted → DLQ

    expect(attempts).toBe(2);
    expect(await redis.pending('ion:events', 'dlq-group', 10)).toHaveLength(0);

    const dlq = redis.entriesOf('ion:events:dlq');
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.fields.topic).toBe('data.x.created');
    expect(dlq[0]?.fields.consumer).toBe('dlq-group');
    expect(dlq[0]?.fields.deliveries).toBe('2');
  });

  it('only sees events published after the group exists ($ semantics)', async () => {
    const { bus, dispatcher } = rig();
    await bus.publish({ topic: 'data.x.created', payload: { early: true } });

    const seen: unknown[] = [];
    bus.on('data.#', 'late-group', (event) => {
      seen.push(event.payload);
    });
    await dispatcher.runPending(); // creates the group at '$'
    await bus.publish({ topic: 'data.x.created', payload: { late: true } });
    await dispatcher.runPending();

    expect(seen).toEqual([{ late: true }]);
  });
});
