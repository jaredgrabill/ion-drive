/**
 * Unit tests for atomic update operators (issue #9): classification and
 * validation of `{ "$inc": n }` / `{ "$dec": n }` values in update bodies.
 */

import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../schema/types.js';
import { splitAtomicOperations } from './atomic-ops.js';
import { DataServiceError } from './data-service.js';

const fields: FieldDefinition[] = [
  { name: 'wins', displayName: 'Wins', columnName: 'wins', columnType: 'integer' },
  { name: 'damage', displayName: 'Damage', columnName: 'damage', columnType: 'float' },
  { name: 'stars', displayName: 'Stars', columnName: 'stars', columnType: 'rating' },
  { name: 'name', displayName: 'Name', columnName: 'name', columnType: 'text' },
  { name: 'meta', displayName: 'Meta', columnName: 'meta', columnType: 'json' },
];

function failure(data: Record<string, unknown>): DataServiceError {
  try {
    splitAtomicOperations(fields, data);
  } catch (err) {
    if (err instanceof DataServiceError) return err;
    throw err;
  }
  throw new Error('expected splitAtomicOperations to throw');
}

describe('splitAtomicOperations', () => {
  it('splits $inc values into increments and leaves plain sets alone', () => {
    const { sets, increments } = splitAtomicOperations(fields, {
      wins: { $inc: 1 },
      name: 'Ada',
    });
    expect(increments).toEqual({ wins: 1 });
    expect(sets).toEqual({ name: 'Ada' });
  });

  it('negates $dec and accepts negative $inc', () => {
    const { increments } = splitAtomicOperations(fields, {
      wins: { $dec: 2 },
      damage: { $inc: -0.5 },
    });
    expect(increments).toEqual({ wins: -2, damage: -0.5 });
  });

  it('supports the rating special type as numeric', () => {
    const { increments } = splitAtomicOperations(fields, { stars: { $inc: 1 } });
    expect(increments).toEqual({ stars: 1 });
  });

  it('treats operator-shaped objects on json columns as plain data', () => {
    const { sets, increments } = splitAtomicOperations(fields, { meta: { $inc: 1 } });
    expect(increments).toEqual({});
    expect(sets).toEqual({ meta: { $inc: 1 } });
  });

  it('rejects operators on non-numeric columns with a 400', () => {
    const err = failure({ name: { $inc: 1 } });
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('INVALID_ATOMIC_OP');
    expect(err.message).toContain('numeric');
  });

  it('rejects mixed operator/value objects', () => {
    const err = failure({ wins: { $inc: 1, extra: 2 } });
    expect(err.code).toBe('INVALID_ATOMIC_OP');
    expect(err.message).toContain('exactly one');
  });

  it('rejects unknown $-operators', () => {
    const err = failure({ wins: { $set: 5 } });
    expect(err.code).toBe('INVALID_ATOMIC_OP');
  });

  it('rejects non-numeric and non-finite amounts', () => {
    expect(failure({ wins: { $inc: 'one' } }).message).toContain('finite number');
    expect(failure({ wins: { $inc: Number.NaN } }).code).toBe('INVALID_ATOMIC_OP');
  });

  it('passes plain objects without $-keys through as sets', () => {
    const { sets, increments } = splitAtomicOperations(fields, { name: { nested: true } });
    expect(increments).toEqual({});
    expect(sets).toEqual({ name: { nested: true } });
  });
});
