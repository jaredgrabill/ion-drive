/**
 * Unit tests for DataService friendly constraint pre-validation (Phase 10 /
 * 1B): API callers get a typed 400 naming the field and rule instead of a raw
 * Postgres CHECK violation.
 */

import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../db/types.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { DataService, DataServiceError } from './data-service.js';

const registry = {
  getTableName: (object: string) => (object === 'deals' ? 'deals' : undefined),
  getFields: () => [
    {
      name: 'title',
      columnName: 'title',
      columnType: 'short_text',
      constraints: { min: 3, max: 10 },
    },
    {
      name: 'amount',
      columnName: 'amount',
      columnType: 'decimal',
      constraints: { min: 0, message: 'Amount cannot be negative' },
    },
    {
      name: 'stage',
      columnName: 'stage',
      columnType: 'enum',
      constraints: { enumValues: ['lead', 'won', 'lost'] },
    },
    {
      name: 'tags',
      columnName: 'tags',
      columnType: 'multi_enum',
      constraints: { enumValues: ['hot', 'cold'] },
    },
    {
      name: 'code',
      columnName: 'code',
      columnType: 'short_text',
      constraints: { pattern: '^[A-Z]{3}$' },
    },
  ],
} as unknown as SchemaRegistry;

/** The insert never runs when validation throws, so a stub suffices. */
const db = {
  transaction: () => ({
    execute: async () => ({ id: 'r1' }),
  }),
} as unknown as Kysely<TenantDatabase>;

const service = new DataService(db, registry);

async function violationOf(data: Record<string, unknown>): Promise<string> {
  try {
    await service.create('deals', data);
    return '';
  } catch (err) {
    expect(err).toBeInstanceOf(DataServiceError);
    expect((err as DataServiceError).code).toBe('CONSTRAINT_VIOLATION');
    expect((err as DataServiceError).statusCode).toBe(400);
    return (err as DataServiceError).message;
  }
}

describe('DataService constraint pre-validation', () => {
  it('rejects text shorter/longer than the length bounds', async () => {
    expect(await violationOf({ title: 'ab' })).toContain('at least 3 characters');
    expect(await violationOf({ title: 'much too long title' })).toContain('at most 10 characters');
  });

  it('rejects numbers outside value bounds, using the custom message', async () => {
    expect(await violationOf({ title: 'valid', amount: -5 })).toBe('Amount cannot be negative');
  });

  it('rejects values outside the enum list', async () => {
    expect(await violationOf({ stage: 'closed' })).toContain('one of: lead, won, lost');
  });

  it('rejects multi-select arrays containing unknown values', async () => {
    expect(await violationOf({ tags: ['hot', 'lukewarm'] })).toContain('lukewarm');
  });

  it('rejects pattern mismatches', async () => {
    expect(await violationOf({ code: 'abc' })).toContain('pattern');
  });

  it('accepts valid values and NULLs (required-ness is NOT NULL, not a constraint)', async () => {
    await expect(
      service.create('deals', { title: 'valid', amount: 10, stage: 'won', tags: ['hot'] }),
    ).resolves.toBeTruthy();
    await expect(service.create('deals', { title: null, stage: null })).resolves.toBeTruthy();
  });
});
