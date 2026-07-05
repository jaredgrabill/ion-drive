import { describe, expect, it } from 'vitest';
import type { LoggerProvider } from '../logging/logger-provider.js';
import { EventDispatcher } from './dispatcher.js';
import type { EventRow, EventStore } from './event-store.js';
import type { BusHandler, IonEvent } from './event-types.js';
import { OutboxBus } from './outbox-bus.js';

const silentLogger: LoggerProvider = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

/**
 * In-memory stand-in for {@link EventStore} that reproduces the delivery
 * semantics the SQL enforces: a `(event, consumer)` claim can be won once, and
 * a failed delivery is reclaimable while under the retry budget. Multi-instance
 * safety is still verified for real against Postgres in the integration smoke.
 */
class InMemoryStore {
  readonly events: IonEvent[] = [];
  readonly deliveries = new Map<string, { status: string; attempts: number; error?: string }>();

  private key(id: string, consumer: string): string {
    return `${id}::${consumer}`;
  }

  async insert(event: IonEvent): Promise<void> {
    this.events.push(event);
  }

  async findCandidates(query: {
    consumer: string;
    batch: number;
    maxAttempts: number;
  }): Promise<EventRow[]> {
    const out: EventRow[] = [];
    for (const e of this.events) {
      const d = this.deliveries.get(this.key(e.id, query.consumer));
      if (!d || (d.status === 'failed' && d.attempts < query.maxAttempts)) {
        out.push({ id: e.id, topic: e.topic, payload: e.payload, occurredAt: e.occurredAt });
      }
      if (out.length >= query.batch) break;
    }
    return out;
  }

  async claim(id: string, consumer: string, maxAttempts: number): Promise<boolean> {
    const k = this.key(id, consumer);
    const d = this.deliveries.get(k);
    if (!d) {
      this.deliveries.set(k, { status: 'pending', attempts: 1 });
      return true;
    }
    if (d.status === 'failed' && d.attempts < maxAttempts) {
      d.status = 'pending';
      d.attempts += 1;
      return true;
    }
    return false;
  }

  async markDone(id: string, consumer: string): Promise<void> {
    const d = this.deliveries.get(this.key(id, consumer));
    if (d) {
      d.status = 'done';
      d.error = undefined;
    }
  }

  async markFailed(id: string, consumer: string, error: string): Promise<void> {
    const d = this.deliveries.get(this.key(id, consumer));
    if (d) {
      d.status = 'failed';
      d.error = error;
    }
  }

  doneCount(): number {
    let n = 0;
    for (const d of this.deliveries.values()) if (d.status === 'done') n += 1;
    return n;
  }
}

/** A handler that counts invocations, optionally failing the first N times. */
function countingHandler(name: string, failFirst = 0) {
  const state = { calls: 0, topics: [] as string[] };
  const handler: BusHandler = {
    name,
    description: 'test',
    async handle(ctx) {
      state.calls += 1;
      state.topics.push(ctx.event.topic);
      if (state.calls <= failFirst) throw new Error('boom');
    },
  };
  return { handler, state };
}

function makeDispatcher(store: InMemoryStore, bus: OutboxBus, instanceId = 'i1') {
  return new EventDispatcher(store as unknown as EventStore, bus, {
    logger: silentLogger,
    instanceId,
  });
}

async function seed(bus: OutboxBus, topics: string[]) {
  for (const topic of topics) await bus.publish({ topic, payload: { topic } });
}

describe('EventDispatcher', () => {
  it('delivers each matching event to a consumer exactly once', async () => {
    const store = new InMemoryStore();
    const bus = new OutboxBus(store as unknown as EventStore);
    const { handler, state } = countingHandler('h');
    bus.registerHandler(handler);
    bus.subscribe({ topic: 'data.#', consumer: 'audit', handler: 'h' });

    await seed(bus, ['data.a.created', 'data.b.updated', 'data.c.deleted']);
    const dispatcher = makeDispatcher(store, bus);

    await dispatcher.runPending();
    expect(state.calls).toBe(3);

    // A second drain delivers nothing new.
    await dispatcher.runPending();
    expect(state.calls).toBe(3);
    expect(store.doneCount()).toBe(3);
  });

  it('fans out to multiple consumer groups (each fires once)', async () => {
    const store = new InMemoryStore();
    const bus = new OutboxBus(store as unknown as EventStore);
    const audit = countingHandler('audit_h');
    const cache = countingHandler('cache_h');
    bus.registerHandler(audit.handler);
    bus.registerHandler(cache.handler);
    bus.subscribe({ topic: 'data.#', consumer: 'audit', handler: 'audit_h' });
    bus.subscribe({ topic: 'data.#', consumer: 'cache', handler: 'cache_h' });

    await seed(bus, ['data.a.created', 'data.b.updated']);
    await makeDispatcher(store, bus).runPending();

    expect(audit.state.calls).toBe(2);
    expect(cache.state.calls).toBe(2);
  });

  it('respects the topic pattern', async () => {
    const store = new InMemoryStore();
    const bus = new OutboxBus(store as unknown as EventStore);
    const { handler, state } = countingHandler('created_only');
    bus.registerHandler(handler);
    bus.subscribe({ topic: 'data.*.created', consumer: 'creates', handler: 'created_only' });

    await seed(bus, ['data.a.created', 'data.b.updated', 'data.c.created']);
    await makeDispatcher(store, bus).runPending();

    expect(state.calls).toBe(2);
    expect(state.topics.sort()).toEqual(['data.a.created', 'data.c.created']);
  });

  it('retries a failed delivery until it succeeds', async () => {
    const store = new InMemoryStore();
    const bus = new OutboxBus(store as unknown as EventStore);
    const { handler, state } = countingHandler('flaky', 1); // fail once, then succeed
    bus.registerHandler(handler);
    bus.subscribe({ topic: 'data.#', consumer: 'r', handler: 'flaky' });

    await seed(bus, ['data.a.created']);
    const dispatcher = makeDispatcher(store, bus);

    await dispatcher.runPending();
    expect(state.calls).toBe(1);
    expect(store.doneCount()).toBe(0); // failed

    await dispatcher.runPending();
    expect(state.calls).toBe(2);
    expect(store.doneCount()).toBe(1); // succeeded on retry
  });

  it('marks a delivery failed when no handler is registered', async () => {
    const store = new InMemoryStore();
    const bus = new OutboxBus(store as unknown as EventStore);
    bus.subscribe({ topic: 'data.#', consumer: 'ghost', handler: 'missing' });

    await seed(bus, ['data.a.created']);
    await makeDispatcher(store, bus).runPending();

    expect(store.doneCount()).toBe(0);
    expect([...store.deliveries.values()][0]?.status).toBe('failed');
  });

  it('perInstance subscriptions deliver once per instance; shared once in total', async () => {
    // Shared group: two instances, delivered once overall.
    const shared = new InMemoryStore();
    const sharedBus = new OutboxBus(shared as unknown as EventStore);
    const sharedH = countingHandler('shared_h');
    sharedBus.registerHandler(sharedH.handler);
    sharedBus.subscribe({ topic: 'data.#', consumer: 'g', handler: 'shared_h' });
    await seed(sharedBus, ['data.a.created', 'data.b.created']);
    await Promise.all([
      makeDispatcher(shared, sharedBus, 'i1').runPending(),
      makeDispatcher(shared, sharedBus, 'i2').runPending(),
    ]);
    expect(sharedH.state.calls).toBe(2);

    // perInstance: each of the two instances delivers its own copy.
    const per = new InMemoryStore();
    const perBus = new OutboxBus(per as unknown as EventStore);
    const perH = countingHandler('per_h');
    perBus.registerHandler(perH.handler);
    perBus.subscribe({ topic: 'data.#', consumer: 'g', handler: 'per_h', perInstance: true });
    await seed(perBus, ['data.a.created', 'data.b.created']);
    await makeDispatcher(per, perBus, 'i1').runPending();
    await makeDispatcher(per, perBus, 'i2').runPending();
    expect(perH.state.calls).toBe(4);
  });
});
