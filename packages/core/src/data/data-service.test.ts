import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../db/types.js';
import type { EventStore } from '../messaging/event-store.js';
import type { CrudEventPayload, IonEvent } from '../messaging/event-types.js';
import { OutboxBus } from '../messaging/outbox-bus.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { DataService } from './data-service.js';

/** A registry double exposing just what the write path needs. */
const registry = {
  getTableName: (object: string) => (object === 'contacts' ? 'contacts' : undefined),
  getFields: () => [
    { name: 'name', columnName: 'name', isSystem: false, isPrimary: false, columnType: 'text' },
    { name: 'age', columnName: 'age', isSystem: false, isPrimary: false, columnType: 'integer' },
  ],
} as unknown as SchemaRegistry;

/** Canned rows returned by the fake tenant db for a single operation. */
interface Canned {
  insertRow?: Record<string, unknown>;
  beforeRow?: Record<string, unknown>;
  updateRow?: Record<string, unknown>;
  deleteRow?: Record<string, unknown>;
}

/** A minimal Kysely stand-in reproducing only the chains DataService uses. */
function fakeDb(canned: Canned): Kysely<TenantDatabase> {
  const trx = {
    insertInto: () => ({
      values: () => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => canned.insertRow,
          execute: async () => (canned.insertRow ? [canned.insertRow] : []),
        }),
      }),
    }),
    selectFrom: () => ({
      selectAll: () => ({ where: () => ({ executeTakeFirst: async () => canned.beforeRow }) }),
    }),
    updateTable: () => ({
      set: () => ({
        where: () => ({ returningAll: () => ({ executeTakeFirst: async () => canned.updateRow }) }),
      }),
    }),
    deleteFrom: () => ({
      where: () => ({
        returningAll: () => ({
          executeTakeFirst: async () => canned.deleteRow,
          execute: async () => (canned.deleteRow ? [canned.deleteRow] : []),
        }),
      }),
    }),
  };
  return {
    transaction: () => ({ execute: async (cb: (t: typeof trx) => unknown) => cb(trx) }),
  } as unknown as Kysely<TenantDatabase>;
}

/** An event store double capturing published envelopes. */
function fakeBus() {
  const events: IonEvent[] = [];
  const store = {
    insert: vi.fn(async (e: IonEvent) => void events.push(e)),
  } as unknown as EventStore;
  return { bus: new OutboxBus(store), events };
}

function payloadOf(event: IonEvent): CrudEventPayload {
  return event.payload as CrudEventPayload;
}

describe('DataService change events', () => {
  it('emits data.<object>.created with the new row as the after-image', async () => {
    const { bus, events } = fakeBus();
    const db = fakeDb({ insertRow: { id: 'r1', name: 'Ann', created_at: 'x', updated_at: 'x' } });
    const service = new DataService(db, registry, bus);

    await service.create('contacts', { name: 'Ann' });

    expect(events).toHaveLength(1);
    expect(events[0]?.topic).toBe('data.contacts.created');
    const payload = payloadOf(events[0] as IonEvent);
    expect(payload).toMatchObject({ object: 'contacts', id: 'r1', op: 'created', before: null });
    expect(payload.after).toMatchObject({ name: 'Ann' });
    expect(payload.diff).toBeNull();
  });

  it('emits data.<object>.updated with a diff that excludes system columns', async () => {
    const { bus, events } = fakeBus();
    const db = fakeDb({
      beforeRow: { id: 'r1', name: 'Ann', updated_at: 't1' },
      updateRow: { id: 'r1', name: 'Anne', updated_at: 't2' },
    });
    const service = new DataService(db, registry, bus);

    await service.update('contacts', 'r1', { name: 'Anne' });

    expect(events[0]?.topic).toBe('data.contacts.updated');
    const payload = payloadOf(events[0] as IonEvent);
    expect(payload.op).toBe('updated');
    expect(payload.diff).toEqual({ name: { before: 'Ann', after: 'Anne' } });
    expect(payload.diff).not.toHaveProperty('updated_at');
  });

  it('emits data.<object>.deleted carrying the removed row as the before-image', async () => {
    const { bus, events } = fakeBus();
    const db = fakeDb({ deleteRow: { id: 'r1', name: 'Ann' } });
    const service = new DataService(db, registry, bus);

    const ok = await service.delete('contacts', 'r1');

    expect(ok).toBe(true);
    expect(events[0]?.topic).toBe('data.contacts.deleted');
    const payload = payloadOf(events[0] as IonEvent);
    expect(payload).toMatchObject({ op: 'deleted', id: 'r1', after: null });
    expect(payload.before).toMatchObject({ name: 'Ann' });
  });

  it('does not emit when the update matches no row', async () => {
    const { bus, events } = fakeBus();
    const service = new DataService(
      fakeDb({ beforeRow: undefined, updateRow: undefined }),
      registry,
      bus,
    );

    const result = await service.update('contacts', 'missing', { name: 'x' });

    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('emits nothing when wired with the default NoopBus', async () => {
    const { events } = fakeBus();
    const service = new DataService(fakeDb({ insertRow: { id: 'r1', name: 'Ann' } }), registry);

    await service.create('contacts', { name: 'Ann' });

    expect(events).toHaveLength(0);
  });
});
