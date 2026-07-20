/**
 * Unit tests for atomic update operators (issue #9): classification and
 * validation of `{ "$inc": n }` / `{ "$dec": n }` values in update bodies.
 */

import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../schema/types.js';
import { assertOperatorTargetsWritable, splitAtomicOperations } from './atomic-ops.js';
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

// ---------------------------------------------------------------------------
// Operator targets that sanitization would silently drop (issue #23)
// ---------------------------------------------------------------------------

const fieldsWithSystem: FieldDefinition[] = [
  ...fields,
  {
    name: 'id',
    displayName: 'ID',
    columnName: 'id',
    columnType: 'uuid',
    isPrimary: true,
    isSystem: true,
  },
  {
    name: 'created_at',
    displayName: 'Created At',
    columnName: 'created_at',
    columnType: 'datetime',
    isSystem: true,
  },
  {
    name: 'updated_by',
    displayName: 'Updated By',
    columnName: 'updated_by',
    columnType: 'text',
    isSystem: true,
  },
];

describe('assertOperatorTargetsWritable', () => {
  function targetFailure(
    data: Record<string, unknown>,
    options: { keepPrimary?: boolean } = {},
  ): DataServiceError {
    try {
      assertOperatorTargetsWritable(fieldsWithSystem, data, options);
    } catch (err) {
      if (err instanceof DataServiceError) return err;
      throw err;
    }
    throw new Error('expected assertOperatorTargetsWritable to throw');
  }

  it('rejects $inc on unknown fields with a 400 naming the field', () => {
    const err = targetFailure({ winz: { $inc: 1 } });
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('INVALID_ATOMIC_OP');
    expect(err.message).toContain('unknown field "winz"');
  });

  it.each(['id', 'created_at', 'updated_by'])('rejects $inc on system field %s', (name) => {
    const err = targetFailure({ [name]: { $inc: 1 } });
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('INVALID_ATOMIC_OP');
    expect(err.message).toContain(`system field "${name}"`);
  });

  it('lets writable fields through — the operator shape is validated later', () => {
    expect(() =>
      assertOperatorTargetsWritable(fieldsWithSystem, { wins: { $inc: 1 }, name: 'Ada' }),
    ).not.toThrow();
  });

  it('treats operator-shaped json values as data, like the splitter does', () => {
    expect(() =>
      assertOperatorTargetsWritable(fieldsWithSystem, { meta: { $inc: 1 } }),
    ).not.toThrow();
  });

  it('ignores plain (non-operator) values on system and unknown keys', () => {
    // The lenient drop-unknowns contract is unchanged for plain values.
    expect(() =>
      assertOperatorTargetsWritable(fieldsWithSystem, { id: 'abc', ghost: 1 }),
    ).not.toThrow();
  });

  it('allows a kept primary key in upsert mode (numeric rule rejects it later)', () => {
    expect(() =>
      assertOperatorTargetsWritable(fieldsWithSystem, { id: { $inc: 1 } }, { keepPrimary: true }),
    ).not.toThrow();
    // Without keepPrimary the same body is a hard 400.
    expect(targetFailure({ id: { $inc: 1 } }).code).toBe('INVALID_ATOMIC_OP');
  });
});
