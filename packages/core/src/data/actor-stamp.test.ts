/**
 * Phase 12 (ADR-019): writes stamp the ambient actor onto the system actor
 * columns and carry it on change events.
 */

import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../db/types.js';
import type { EventStore } from '../messaging/event-store.js';
import type { CrudEventPayload, IonEvent } from '../messaging/event-types.js';
import { OutboxBus } from '../messaging/outbox-bus.js';
import { runWithActor } from '../runtime/request-context.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { DataService } from './data-service.js';

const field = (name: string, isSystem = false) => ({
  name,
  columnName: name,
  isSystem,
  isPrimary: false,
  columnType: 'text',
});

/** Registry double: an object that has the Phase 12 actor columns. */
const registry = {
  getTableName: (object: string) => (object === 'contacts' ? 'contacts' : undefined),
  getFields: () => [field('name'), field('created_by', true), field('updated_by', true)],
} as unknown as SchemaRegistry;

/** Registry double: a pre-Phase-12 object without the actor columns. */
const legacyRegistry = {
  getTableName: () => 'legacy',
  getFields: () => [field('name')],
} as unknown as SchemaRegistry;

/** Fake db capturing the values handed to insert/update. */
function capturingDb() {
  const captured: { inserted?: Record<string, unknown>; updated?: Record<string, unknown> } = {};
  const trx = {
    insertInto: () => ({
      values: (v: Record<string, unknown>) => {
        captured.inserted = v;
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => ({ id: 'r1', ...v }),
            execute: async () => [{ id: 'r1', ...v }],
          }),
        };
      },
    }),
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({ executeTakeFirst: async () => ({ id: 'r1', name: 'old' }) }),
      }),
    }),
    updateTable: () => ({
      set: (v: Record<string, unknown>) => {
        captured.updated = v;
        return {
          where: () => ({
            returningAll: () => ({ executeTakeFirst: async () => ({ id: 'r1', ...v }) }),
          }),
        };
      },
    }),
  };
  const db = {
    transaction: () => ({ execute: async (cb: (t: typeof trx) => unknown) => cb(trx) }),
  } as unknown as Kysely<TenantDatabase>;
  return { db, captured };
}

function busCapture() {
  const events: IonEvent[] = [];
  const store = { insert: vi.fn(async (e: IonEvent) => void events.push(e)) };
  return { bus: new OutboxBus(store as unknown as EventStore), events };
}

const sessionActor = { userId: 'user-1', apiKeyId: null, via: 'session' as const };

describe('actor identity on writes', () => {
  it('create stamps created_by and updated_by from the ambient actor', async () => {
    const { db, captured } = capturingDb();
    const service = new DataService(db, registry);

    await runWithActor(sessionActor, () => service.create('contacts', { name: 'Ann' }));

    expect(captured.inserted).toMatchObject({
      name: 'Ann',
      created_by: 'user-1',
      updated_by: 'user-1',
    });
  });

  it('update stamps only updated_by', async () => {
    const { db, captured } = capturingDb();
    const service = new DataService(db, registry);

    await runWithActor(sessionActor, () => service.update('contacts', 'r1', { name: 'Anne' }));

    expect(captured.updated).toMatchObject({ name: 'Anne', updated_by: 'user-1' });
    expect(captured.updated).not.toHaveProperty('created_by');
  });

  it('anonymous writes stamp nothing', async () => {
    const { db, captured } = capturingDb();
    const service = new DataService(db, registry);

    await service.create('contacts', { name: 'Ann' });

    expect(captured.inserted).not.toHaveProperty('created_by');
    expect(captured.inserted).not.toHaveProperty('updated_by');
  });

  it('objects without the actor columns are left untouched (no unknown-column write)', async () => {
    const { db, captured } = capturingDb();
    const service = new DataService(db, legacyRegistry);

    await runWithActor(sessionActor, () => service.create('legacy', { name: 'Ann' }));

    expect(captured.inserted).toEqual({ name: 'Ann' });
  });

  it('client-supplied actor columns are stripped, not trusted', async () => {
    const { db, captured } = capturingDb();
    const service = new DataService(db, registry);

    await runWithActor(sessionActor, () =>
      service.create('contacts', { name: 'Ann', created_by: 'forged' }),
    );

    expect(captured.inserted?.created_by).toBe('user-1');
  });

  it('change events carry the actor (and null when anonymous)', async () => {
    const { db } = capturingDb();
    const { bus, events } = busCapture();
    const service = new DataService(db, registry, bus);

    await runWithActor(sessionActor, () => service.create('contacts', { name: 'Ann' }));
    await service.update('contacts', 'r1', { name: 'Anne' });

    expect((events[0]?.payload as CrudEventPayload).actor).toEqual(sessionActor);
    expect((events[1]?.payload as CrudEventPayload).actor).toBeNull();
  });
});
