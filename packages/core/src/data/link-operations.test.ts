import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../db/types.js';
import type { EventStore } from '../messaging/event-store.js';
import type { IonEvent, LinkEventPayload } from '../messaging/event-types.js';
import { OutboxBus } from '../messaging/outbox-bus.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { DataService, DataServiceError } from './data-service.js';

/** contacts <-m2m:tags-> tags, plus a many_to_one for the negative test. */
const registry = {
  getTableName: (object: string) =>
    ({ contacts: 'contacts', tags: 'tags', companies: 'companies' })[object],
  getFields: () => [],
  getObject: (object: string) =>
    object === 'contacts'
      ? {
          name: 'contacts',
          tableName: 'contacts',
          fields: [],
          relationships: [
            {
              name: 'tags',
              displayName: 'Tags',
              type: 'many_to_many',
              sourceObjectName: 'contacts',
              targetObjectName: 'tags',
              junctionTable: 'contacts_tags',
              junctionSourceColumn: 'contacts_id',
              junctionTargetColumn: 'tags_id',
            },
            {
              name: 'company',
              displayName: 'Company',
              type: 'many_to_one',
              sourceObjectName: 'contacts',
              targetObjectName: 'companies',
            },
          ],
        }
      : undefined,
} as unknown as SchemaRegistry;

interface FakeDbOptions {
  /** Whether the record-existence probe finds the row. */
  recordExists?: boolean;
  /** Junction rows returned by the transactional insert (post-conflict-skip). */
  insertedRows?: Record<string, unknown>[];
  /** Junction rows returned by the transactional delete. */
  deletedRows?: Record<string, unknown>[];
  /** When set, the insert rejects with this error (e.g. a PG FK violation). */
  insertError?: Error;
}

/** Captures the junction chains addLinks/removeLinks build. */
function fakeDb(options: FakeDbOptions) {
  const calls = {
    insertedInto: [] as string[],
    insertedValues: [] as Record<string, unknown>[][],
    conflictColumns: [] as string[][],
    deletedFrom: [] as string[],
  };
  const trx = {
    insertInto: (table: string) => {
      calls.insertedInto.push(table);
      return {
        values: (rows: Record<string, unknown>[]) => {
          calls.insertedValues.push(rows);
          return {
            onConflict: (cb: (oc: unknown) => unknown) => {
              cb({
                columns: (cols: string[]) => {
                  calls.conflictColumns.push(cols);
                  return { doNothing: () => ({}) };
                },
              });
              return {
                returningAll: () => ({
                  execute: async () => {
                    if (options.insertError) throw options.insertError;
                    return options.insertedRows ?? [];
                  },
                }),
              };
            },
          };
        },
      };
    },
    deleteFrom: (table: string) => {
      calls.deletedFrom.push(table);
      return {
        where: () => ({
          where: () => ({
            returningAll: () => ({ execute: async () => options.deletedRows ?? [] }),
          }),
        }),
      };
    },
  };
  const db = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () => ((options.recordExists ?? true) ? { id: 'c1' } : undefined),
        }),
      }),
    }),
    transaction: () => ({ execute: async (cb: (t: typeof trx) => unknown) => cb(trx) }),
  } as unknown as Kysely<TenantDatabase>;
  return { db, calls };
}

function fakeBus() {
  const events: IonEvent[] = [];
  const store = {
    insert: vi.fn(async (e: IonEvent) => void events.push(e)),
  } as unknown as EventStore;
  return { bus: new OutboxBus(store), events };
}

describe('DataService.addLinks', () => {
  it('inserts junction rows idempotently and emits data.<object>.linked with the added ids', async () => {
    const { bus, events } = fakeBus();
    const { db, calls } = fakeDb({
      insertedRows: [{ contacts_id: 'c1', tags_id: 't1' }],
    });
    const service = new DataService(db, registry, bus);

    const result = await service.addLinks('contacts', 'c1', 'tags', ['t1', 't2', 't1']);

    expect(result).toEqual({ added: 1 });
    expect(calls.insertedInto).toEqual(['contacts_tags']);
    // De-duplicated input: t1 appears once.
    expect(calls.insertedValues[0]).toEqual([
      { contacts_id: 'c1', tags_id: 't1' },
      { contacts_id: 'c1', tags_id: 't2' },
    ]);
    expect(calls.conflictColumns[0]).toEqual(['contacts_id', 'tags_id']);

    expect(events).toHaveLength(1);
    expect(events[0]?.topic).toBe('data.contacts.linked');
    const payload = events[0]?.payload as LinkEventPayload;
    expect(payload).toMatchObject({
      object: 'contacts',
      id: 'c1',
      op: 'linked',
      relationship: 'tags',
      targetObject: 'tags',
      targetIds: ['t1'],
    });
  });

  it('emits nothing when every pair was already linked', async () => {
    const { bus, events } = fakeBus();
    const { db } = fakeDb({ insertedRows: [] });
    const service = new DataService(db, registry, bus);

    const result = await service.addLinks('contacts', 'c1', 'tags', ['t1']);

    expect(result).toEqual({ added: 0 });
    expect(events).toHaveLength(0);
  });

  it('short-circuits an empty ids list without touching the db', async () => {
    const { db, calls } = fakeDb({});
    const service = new DataService(db, registry);

    expect(await service.addLinks('contacts', 'c1', 'tags', [])).toEqual({ added: 0 });
    expect(calls.insertedInto).toEqual([]);
  });

  it('rejects an unknown relationship with a 400', async () => {
    const service = new DataService(fakeDb({}).db, registry);
    await expect(service.addLinks('contacts', 'c1', 'nope', ['t1'])).rejects.toMatchObject({
      code: 'UNKNOWN_RELATIONSHIP',
      statusCode: 400,
    });
  });

  it('rejects a non-many_to_many relationship, pointing at the FK field', async () => {
    const service = new DataService(fakeDb({}).db, registry);
    const err = await service.addLinks('contacts', 'c1', 'company', ['x']).catch((e) => e);
    expect(err).toBeInstanceOf(DataServiceError);
    expect(err.code).toBe('NOT_MANY_TO_MANY');
    expect(err.message).toContain('company_id');
  });

  it('404s when the record does not exist', async () => {
    const service = new DataService(fakeDb({ recordExists: false }).db, registry);
    await expect(service.addLinks('contacts', 'missing', 'tags', ['t1'])).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('maps a junction FK violation to a friendly UNKNOWN_TARGET 400', async () => {
    const pgError = Object.assign(new Error('violates foreign key'), { code: '23503' });
    const service = new DataService(fakeDb({ insertError: pgError }).db, registry);
    const err = await service.addLinks('contacts', 'c1', 'tags', ['ghost']).catch((e) => e);
    expect(err).toBeInstanceOf(DataServiceError);
    expect(err.code).toBe('UNKNOWN_TARGET');
    expect(err.message).toContain('tags');
  });
});

describe('DataService.removeLinks', () => {
  it('deletes junction rows and emits data.<object>.unlinked with the removed ids', async () => {
    const { bus, events } = fakeBus();
    const { db, calls } = fakeDb({
      deletedRows: [
        { contacts_id: 'c1', tags_id: 't1' },
        { contacts_id: 'c1', tags_id: 't2' },
      ],
    });
    const service = new DataService(db, registry, bus);

    const result = await service.removeLinks('contacts', 'c1', 'tags', ['t1', 't2', 'not-linked']);

    expect(result).toEqual({ removed: 2 });
    expect(calls.deletedFrom).toEqual(['contacts_tags']);
    expect(events[0]?.topic).toBe('data.contacts.unlinked');
    expect((events[0]?.payload as LinkEventPayload).targetIds).toEqual(['t1', 't2']);
  });

  it('emits nothing when no links matched', async () => {
    const { bus, events } = fakeBus();
    const service = new DataService(fakeDb({ deletedRows: [] }).db, registry, bus);

    expect(await service.removeLinks('contacts', 'c1', 'tags', ['t9'])).toEqual({ removed: 0 });
    expect(events).toHaveLength(0);
  });
});
