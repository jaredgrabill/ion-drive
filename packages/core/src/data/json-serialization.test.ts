/**
 * Unit tests for json-column value binding (issue #10).
 *
 * DataService must stringify objects/arrays bound to `json` columns at the
 * binding boundary — node-postgres would serialize a JS array as a Postgres
 * array literal (invalid JSON) — while passing pre-encoded strings through
 * unchanged for back-compat, and leaving non-json columns alone. Uses a
 * capturing Kysely stand-in to observe exactly what would hit the driver.
 */

import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../db/types.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { DataService } from './data-service.js';

/** A registry double with a json column, a text column, and a text array. */
const registry = {
  getTableName: (object: string) => (object === 'matches' ? 'matches' : undefined),
  getFields: () => [
    { name: 'title', columnName: 'title', isSystem: false, isPrimary: false, columnType: 'text' },
    {
      name: 'config_json',
      columnName: 'config_json',
      isSystem: false,
      isPrimary: false,
      columnType: 'json',
    },
    {
      name: 'tags',
      columnName: 'tags',
      isSystem: false,
      isPrimary: false,
      columnType: 'array_text',
    },
  ],
} as unknown as SchemaRegistry;

/** A Kysely stand-in that records the values bound to inserts/updates. */
function capturingDb(captured: { values: Record<string, unknown>[] }): Kysely<TenantDatabase> {
  const record = (data: Record<string, unknown> | Record<string, unknown>[]) => {
    for (const row of Array.isArray(data) ? data : [data]) captured.values.push(row);
  };
  const trx = {
    insertInto: () => ({
      values: (data: Record<string, unknown> | Record<string, unknown>[]) => {
        record(data);
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => ({ id: '1' }),
            execute: async () => [{ id: '1' }],
          }),
          execute: async () => [{ id: '1' }],
        };
      },
    }),
    updateTable: () => ({
      set: (data: Record<string, unknown>) => {
        record(data);
        return {
          where: () => ({ returningAll: () => ({ executeTakeFirst: async () => ({ id: '1' }) }) }),
        };
      },
    }),
  };
  return {
    transaction: () => ({ execute: async (cb: (t: typeof trx) => unknown) => cb(trx) }),
    insertInto: trx.insertInto,
  } as unknown as Kysely<TenantDatabase>;
}

function makeService(): { service: DataService; captured: { values: Record<string, unknown>[] } } {
  const captured = { values: [] as Record<string, unknown>[] };
  return { service: new DataService(capturingDb(captured), registry), captured };
}

describe('json column binding', () => {
  it('stringifies a JSON object on create', async () => {
    const { service, captured } = makeService();
    await service.create('matches', { config_json: { a: 1, nested: { b: [1, 'x'] } } });
    expect(captured.values[0]?.config_json).toBe('{"a":1,"nested":{"b":[1,"x"]}}');
  });

  it('stringifies a JSON array on create (pg would bind it as a Postgres array literal)', async () => {
    const { service, captured } = makeService();
    await service.create('matches', { config_json: [1, 2, { b: 3 }] });
    expect(captured.values[0]?.config_json).toBe('[1,2,{"b":3}]');
  });

  it('passes a pre-encoded JSON string through unchanged (back-compat)', async () => {
    const { service, captured } = makeService();
    await service.create('matches', { config_json: '{"a":1}' });
    expect(captured.values[0]?.config_json).toBe('{"a":1}');
  });

  it('leaves null and scalar values alone', async () => {
    const { service, captured } = makeService();
    await service.create('matches', { config_json: null });
    expect(captured.values[0]?.config_json).toBeNull();
  });

  it('stringifies on update too', async () => {
    const { service, captured } = makeService();
    await service.update('matches', '1', { config_json: { theme: 'dark' } });
    expect(captured.values[0]?.config_json).toBe('{"theme":"dark"}');
  });

  it('stringifies each record on bulkCreate', async () => {
    const { service, captured } = makeService();
    await service.bulkCreate('matches', [{ config_json: { a: 1 } }, { config_json: [true] }]);
    expect(captured.values.map((v) => v.config_json)).toEqual(['{"a":1}', '[true]']);
  });

  it('does not stringify non-json columns (arrays for array_text stay arrays)', async () => {
    const { service, captured } = makeService();
    await service.create('matches', { title: 'x', tags: ['a', 'b'] });
    expect(captured.values[0]?.title).toBe('x');
    expect(captured.values[0]?.tags).toEqual(['a', 'b']);
  });
});
