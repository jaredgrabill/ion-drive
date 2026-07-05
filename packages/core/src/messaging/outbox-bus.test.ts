import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from './event-store.js';
import type { BusHandler, IonEvent } from './event-types.js';
import { OutboxBus } from './outbox-bus.js';

/** A store double capturing inserted events. */
function fakeStore() {
  const inserted: IonEvent[] = [];
  const store = {
    insert: vi.fn(async (event: IonEvent) => void inserted.push(event)),
  } as unknown as EventStore;
  return { store, inserted };
}

describe('OutboxBus', () => {
  it('publish assigns an id/timestamp and inserts the event, then wakes', async () => {
    const { store, inserted } = fakeStore();
    const bus = new OutboxBus(store);
    const woke = vi.fn();
    bus.setWakeHandler(woke);

    await bus.publish({ topic: 'data.contacts.created', payload: { id: '1' } });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.topic).toBe('data.contacts.created');
    expect(inserted[0]?.id).toBeTruthy();
    expect(inserted[0]?.occurredAt).toBeInstanceOf(Date);
    expect(woke).toHaveBeenCalledOnce();
  });

  it('does not wake when publishing inside a transaction (caller wakes post-commit)', async () => {
    const { store } = fakeStore();
    const bus = new OutboxBus(store);
    const woke = vi.fn();
    bus.setWakeHandler(woke);

    // A truthy "transaction" stand-in; the store double ignores it.
    await bus.publish({ topic: 't', payload: {} }, {} as never);
    expect(woke).not.toHaveBeenCalled();
  });

  it('registers handlers and reports their presence', () => {
    const { store } = fakeStore();
    const bus = new OutboxBus(store);
    const handler: BusHandler = { name: 'h', description: 'x', handle: async () => {} };
    bus.registerHandler(handler);
    expect(bus.hasHandler('h')).toBe(true);
    expect(bus.getHandler('h')).toBe(handler);
    expect(bus.hasHandler('nope')).toBe(false);
  });

  it('on() registers an inline handler and a subscription bound to it', () => {
    const { store } = fakeStore();
    const bus = new OutboxBus(store);
    bus.on('data.#', 'cache', async () => {}, { perInstance: true });

    const subs = bus.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.consumer).toBe('cache');
    expect(subs[0]?.perInstance).toBe(true);
    expect(bus.getHandler(subs[0]?.handler ?? '')).toBeDefined();
  });

  it('unsubscribeConsumer removes only that consumer’s subscriptions', () => {
    const { store } = fakeStore();
    const bus = new OutboxBus(store);
    bus.subscribe({ topic: 'data.#', consumer: 'audit', handler: 'persist_event' });
    bus.subscribe({ topic: 'data.#', consumer: 'cache', handler: 'log_event' });

    bus.unsubscribeConsumer('audit');

    const subs = bus.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.consumer).toBe('cache');
  });
});
