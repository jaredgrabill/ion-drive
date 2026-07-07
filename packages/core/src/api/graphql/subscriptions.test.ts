import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionEngine } from '../../auth/rbac/permission-engine.js';
import type { IonEvent } from '../../messaging/event-types.js';
import type { RealtimeBridge, RealtimeListener } from '../../messaging/realtime.js';
import { makeEventsSubscribe } from './subscriptions.js';

/** A bridge double capturing the subscription and letting tests push events. */
function fakeBridge() {
  let listener: RealtimeListener | null = null;
  let topics: string[] = [];
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const bridge = {
    subscribe: (t: string[], l: RealtimeListener) => {
      topics = t;
      listener = l;
      return unsubscribe;
    },
  } as unknown as RealtimeBridge;
  return {
    bridge,
    unsubscribe,
    getTopics: () => topics,
    push: (event: IonEvent) => listener?.(event),
  };
}

function event(topic: string, id = 'e1'): IonEvent {
  return { id, topic, payload: { object: 'contacts' }, occurredAt: new Date() };
}

const allowAll = { can: async () => true } as unknown as PermissionEngine;

describe('makeEventsSubscribe', () => {
  it('yields pushed events and defaults topics to data.#', async () => {
    const { bridge, push, getTopics } = fakeBridge();
    const subscribe = makeEventsSubscribe({
      realtime: bridge,
      permissionEngine: allowAll,
      enforce: false,
    });

    const iterator = subscribe(null, {}, {}, {} as never) as AsyncIterableIterator<IonEvent>;
    const first = iterator.next();
    await push(event('data.contacts.created'));

    expect((await first).value.topic).toBe('data.contacts.created');
    expect(getTopics()).toEqual(['data.#']);
  });

  it('unsubscribes from the bridge when the client disconnects (return)', async () => {
    const { bridge, unsubscribe } = fakeBridge();
    const subscribe = makeEventsSubscribe({
      realtime: bridge,
      permissionEngine: allowAll,
      enforce: false,
    });

    const iterator = subscribe(
      null,
      { topics: ['data.orders.*'] },
      {},
      {} as never,
    ) as AsyncIterableIterator<IonEvent>;
    const result = await iterator.return?.();

    expect(result?.done).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect((await iterator.next()).done).toBe(true);
  });

  it('skips events the principal may not read (per-event RBAC)', async () => {
    const { bridge, push } = fakeBridge();
    const can = vi.fn(async (_auth: unknown, _action: string, resource: string) => {
      return resource === 'contacts';
    });
    const subscribe = makeEventsSubscribe({
      realtime: bridge,
      permissionEngine: { can } as unknown as PermissionEngine,
      enforce: true,
    });

    const context = { req: { auth: { userId: 'u1' } } };
    const iterator = subscribe(null, {}, context, {} as never) as AsyncIterableIterator<IonEvent>;
    const first = iterator.next();
    await push(event('data.secrets_obj.created', 'denied'));
    await push(event('data.contacts.created', 'allowed'));

    expect((await first).value.id).toBe('allowed');
  });

  it('rejects anonymous subscribers under enforcement', () => {
    const { bridge } = fakeBridge();
    const subscribe = makeEventsSubscribe({
      realtime: bridge,
      permissionEngine: allowAll,
      enforce: true,
    });
    expect(() => subscribe(null, {}, { req: { auth: null } }, {} as never)).toThrow(GraphQLError);
  });
});
