/**
 * Phase 12 (ADR-019): the realtime bridge — cursor semantics, topic matching,
 * dedupe, and subscriber lifecycle.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EventRow, EventStore } from './event-store.js';
import type { IonEvent } from './event-types.js';
import { RealtimeBridge } from './realtime.js';

function row(id: string, topic: string, occurredAt = new Date()): EventRow {
  return { id, topic, payload: { id }, occurredAt };
}

/** Store double whose listSince returns queued batches. */
function fakeStore(batches: EventRow[][]) {
  const listSince = vi.fn(async () => batches.shift() ?? []);
  return { store: { listSince } as unknown as EventStore, listSince };
}

async function drainOnce(bridge: RealtimeBridge) {
  bridge.trigger();
  // trigger() runs the drain as a microtask chain; give it a tick.
  await new Promise((r) => setImmediate(r));
}

describe('RealtimeBridge', () => {
  it('fans matching events out to subscribers by topic pattern', async () => {
    const { store } = fakeStore([
      [row('e1', 'data.contacts.created'), row('e2', 'data.orders.created')],
    ]);
    const bridge = new RealtimeBridge(store, { pollIntervalMs: 60_000 });

    const contacts: IonEvent[] = [];
    const everything: IonEvent[] = [];
    const unsubA = bridge.subscribe(['data.contacts.*'], (e) => void contacts.push(e));
    const unsubB = bridge.subscribe(['data.#'], (e) => void everything.push(e));

    await drainOnce(bridge);

    expect(contacts.map((e) => e.id)).toEqual(['e1']);
    expect(everything.map((e) => e.id)).toEqual(['e1', 'e2']);
    unsubA();
    unsubB();
  });

  it('dedupes events re-read through the overlap window', async () => {
    const e1 = row('e1', 'data.contacts.created');
    const { store } = fakeStore([[e1], [e1, row('e2', 'data.contacts.created')]]);
    const bridge = new RealtimeBridge(store, { pollIntervalMs: 60_000 });

    const seen: string[] = [];
    const unsub = bridge.subscribe(['data.#'], (e) => void seen.push(e.id));
    await drainOnce(bridge);
    await drainOnce(bridge);

    expect(seen).toEqual(['e1', 'e2']);
    unsub();
  });

  it('advances the cursor to the newest occurred_at seen', async () => {
    // Future-dated relative to the connect-time cursor — the cursor only ever
    // moves forward (older rows arrive via the overlap window instead).
    const t1 = new Date(Date.now() + 1_000);
    const t2 = new Date(Date.now() + 2_000);
    const { store, listSince } = fakeStore([
      [row('e1', 'data.a.created', t1), row('e2', 'data.a.created', t2)],
      [],
    ]);
    const bridge = new RealtimeBridge(store, { pollIntervalMs: 60_000 });
    const unsub = bridge.subscribe(['data.#'], () => {});

    await drainOnce(bridge);
    await drainOnce(bridge);

    const secondCall = listSince.mock.calls[1]?.[0] as { after: Date };
    expect(secondCall.after).toEqual(t2);
    unsub();
  });

  it('stops polling when the last subscriber leaves and only polls while subscribed', async () => {
    const { store, listSince } = fakeStore([[], [], []]);
    const bridge = new RealtimeBridge(store, { pollIntervalMs: 60_000 });

    bridge.trigger(); // no subscribers → no query
    await new Promise((r) => setImmediate(r));
    expect(listSince).not.toHaveBeenCalled();

    const unsub = bridge.subscribe(['data.#'], () => {});
    await drainOnce(bridge);
    expect(listSince).toHaveBeenCalledTimes(1);
    expect(bridge.subscriberCount).toBe(1);

    unsub();
    expect(bridge.subscriberCount).toBe(0);
    bridge.trigger();
    await new Promise((r) => setImmediate(r));
    expect(listSince).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not break the fan-out to others', async () => {
    const { store } = fakeStore([[row('e1', 'data.a.created')]]);
    const bridge = new RealtimeBridge(store, { pollIntervalMs: 60_000 });

    const seen: string[] = [];
    const unsubBad = bridge.subscribe(['data.#'], () => {
      throw new Error('boom');
    });
    const unsubGood = bridge.subscribe(['data.#'], (e) => void seen.push(e.id));

    await drainOnce(bridge);

    expect(seen).toEqual(['e1']);
    unsubBad();
    unsubGood();
  });
});
