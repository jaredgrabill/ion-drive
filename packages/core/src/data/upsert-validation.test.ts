/**
 * Unit tests for upsert conflict-target validation (issue #9): only declared
 * unique constraints — an isUnique field, the primary key, or a
 * constraints.uniqueTogether group — are legal `on_conflict` targets, and the
 * body must carry a value for every target column.
 */

import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../db/types.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import type { DataObjectDefinition } from '../schema/types.js';
import { DataService, DataServiceError } from './data-service.js';

const matches: DataObjectDefinition = {
  name: 'matches',
  displayName: 'Matches',
  tableName: 'matches',
  fields: [
    {
      name: 'id',
      displayName: 'ID',
      columnName: 'id',
      columnType: 'uuid',
      isPrimary: true,
      isSystem: true,
    },
    {
      name: 'device_id',
      displayName: 'Device',
      columnName: 'device_id',
      columnType: 'text',
      isUnique: true,
    },
    { name: 'room_code', displayName: 'Room', columnName: 'room_code', columnType: 'text' },
    { name: 'seed', displayName: 'Seed', columnName: 'seed', columnType: 'integer' },
    { name: 'winner', displayName: 'Winner', columnName: 'winner', columnType: 'text' },
  ],
  constraints: { uniqueTogether: [['room_code', 'seed']] },
};

const registry = {
  getTableName: (object: string) => (object === 'matches' ? 'matches' : undefined),
  getObject: (object: string) => (object === 'matches' ? matches : undefined),
  getFields: (object: string) => (object === 'matches' ? matches.fields : []),
} as unknown as SchemaRegistry;

/** The insert never runs when validation throws, so a stub suffices. */
const db = {
  transaction: () => ({
    execute: async () => ({ record: { id: 'r1' }, created: true }),
  }),
} as unknown as Kysely<TenantDatabase>;

const service = new DataService(db, registry);

async function failure(
  data: Record<string, unknown>,
  onConflict: string[],
): Promise<DataServiceError> {
  try {
    await service.upsert('matches', data, onConflict);
  } catch (err) {
    if (err instanceof DataServiceError) return err;
    throw err;
  }
  throw new Error('expected upsert to throw');
}

describe('upsert conflict-target validation', () => {
  it('accepts a single isUnique field', async () => {
    const result = await service.upsert('matches', { device_id: 'd1' }, ['device_id']);
    expect(result.created).toBe(true);
  });

  it('accepts the primary key as target (and keeps its value)', async () => {
    const result = await service.upsert('matches', { id: 'abc', winner: 'x' }, ['id']);
    expect(result.created).toBe(true);
  });

  it('accepts a uniqueTogether group in any order', async () => {
    const result = await service.upsert('matches', { room_code: 'r', seed: 1 }, [
      'seed',
      'room_code',
    ]);
    expect(result.created).toBe(true);
  });

  it('rejects a non-unique column with a 400 naming the valid targets', async () => {
    const err = await failure({ winner: 'x' }, ['winner']);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('INVALID_CONFLICT_TARGET');
    expect(err.message).toContain('device_id');
    expect(err.message).toContain('(room_code, seed)');
  });

  it('rejects a subset of a uniqueTogether group', async () => {
    const err = await failure({ room_code: 'r' }, ['room_code']);
    expect(err.code).toBe('INVALID_CONFLICT_TARGET');
  });

  it('rejects unknown fields', async () => {
    const err = await failure({ nope: 1 }, ['nope']);
    expect(err.code).toBe('UNKNOWN_FIELD');
  });

  it('rejects an empty target list', async () => {
    const err = await failure({ device_id: 'd' }, ['  ']);
    expect(err.code).toBe('INVALID_CONFLICT_TARGET');
  });

  it('requires a body value for every conflict column', async () => {
    const err = await failure({ room_code: 'r' }, ['room_code', 'seed']);
    expect(err.code).toBe('MISSING_CONFLICT_VALUE');
    expect(err.message).toContain('seed');
  });
});
