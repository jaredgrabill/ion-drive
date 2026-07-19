/**
 * Unit tests for the Postgres → error-contract translation (errors.ts).
 *
 * Fabricates node-postgres-shaped error objects (code/detail/column/
 * constraint/table, exactly what the driver raises) and asserts each mapped
 * SQLSTATE lands on its documented status + stable `error` slug, that the
 * offending field is parsed out where possible, that internal constraint
 * names never leak into messages, and that everything else passes through
 * untouched. Covers issue #11.
 */

import { describe, expect, it } from 'vitest';
import { DataServiceError, translatePgError } from './errors.js';

/** Builds a pg DatabaseError look-alike. */
function pgError(fields: {
  code: string;
  message?: string;
  detail?: string;
  column?: string;
  constraint?: string;
  table?: string;
}): Error {
  const err = new Error(fields.message ?? 'db error');
  Object.assign(err, fields);
  return err;
}

describe('translatePgError', () => {
  describe('23505 unique violation', () => {
    it('maps to 409 unique_violation with the field parsed from the detail', () => {
      const result = translatePgError(
        pgError({
          code: '23505',
          message: 'duplicate key value violates unique constraint "players_device_id_key"',
          detail: 'Key (device_id)=(abc-123) already exists.',
          constraint: 'players_device_id_key',
          table: 'players',
        }),
      ) as DataServiceError;

      expect(result).toBeInstanceOf(DataServiceError);
      expect(result.statusCode).toBe(409);
      expect(result.code).toBe('unique_violation');
      expect(result.field).toBe('device_id');
      // The internal constraint name must not leak.
      expect(result.message).not.toContain('players_device_id_key');
      expect(result.message).toContain('device_id');
    });

    it('falls back to parsing the constraint name when there is no detail', () => {
      const result = translatePgError(
        pgError({
          code: '23505',
          constraint: 'players_device_id_key',
          table: 'players',
        }),
      ) as DataServiceError;

      expect(result.code).toBe('unique_violation');
      expect(result.field).toBe('device_id');
    });

    it('reports composite keys as the column list', () => {
      const result = translatePgError(
        pgError({
          code: '23505',
          detail: 'Key (org_id, slug)=(1, home) already exists.',
        }),
      ) as DataServiceError;

      expect(result.field).toBe('org_id, slug');
    });

    it('still maps without any parsable field', () => {
      const result = translatePgError(pgError({ code: '23505' })) as DataServiceError;
      expect(result.statusCode).toBe(409);
      expect(result.code).toBe('unique_violation');
      expect(result.field).toBeUndefined();
    });
  });

  describe('23503 foreign key violation', () => {
    it('maps a missing referenced record to 409 foreign_key_violation', () => {
      const result = translatePgError(
        pgError({
          code: '23503',
          message: 'insert or update on table "contacts" violates foreign key constraint',
          detail: 'Key (company_id)=(9f8e…) is not present in table "companies".',
          constraint: 'contacts_company_id_fkey',
        }),
      ) as DataServiceError;

      expect(result.statusCode).toBe(409);
      expect(result.code).toBe('foreign_key_violation');
      expect(result.field).toBe('company_id');
      expect(result.message).not.toContain('contacts_company_id_fkey');
    });

    it('maps a still-referenced delete to 409 foreign_key_violation', () => {
      const result = translatePgError(
        pgError({
          code: '23503',
          detail: 'Key (id)=(9f8e…) is still referenced from table "contacts".',
        }),
      ) as DataServiceError;

      expect(result.statusCode).toBe(409);
      expect(result.code).toBe('foreign_key_violation');
      expect(result.message).toContain('still referenced');
    });
  });

  describe('23502 not-null violation', () => {
    it('maps to 400 not_null_violation naming the column', () => {
      const result = translatePgError(
        pgError({
          code: '23502',
          message: 'null value in column "full_name" of relation "contacts" violates not-null',
          column: 'full_name',
          table: 'contacts',
        }),
      ) as DataServiceError;

      expect(result.statusCode).toBe(400);
      expect(result.code).toBe('not_null_violation');
      expect(result.field).toBe('full_name');
      expect(result.message).toContain('full_name');
    });
  });

  describe('22* invalid input', () => {
    it.each(['22P02', '22007', '22008'])('maps %s to 400 invalid_value', (code) => {
      const result = translatePgError(
        pgError({ code, message: 'invalid input syntax for type json' }),
      ) as DataServiceError;

      expect(result.statusCode).toBe(400);
      expect(result.code).toBe('invalid_value');
      expect(result.message).toBe('invalid input syntax for type json');
    });
  });

  describe('pass-through', () => {
    it('leaves unrelated SQLSTATEs untouched', () => {
      const original = pgError({ code: '42P01', message: 'relation does not exist' });
      expect(translatePgError(original)).toBe(original);
    });

    it('leaves non-Postgres errors untouched', () => {
      const original = new Error('boom');
      expect(translatePgError(original)).toBe(original);
      expect(translatePgError(undefined)).toBeUndefined();
      expect(translatePgError(null)).toBeNull();
    });

    it('leaves already-typed DataServiceErrors untouched', () => {
      const original = new DataServiceError('nope', 'CONSTRAINT_VIOLATION', 400);
      expect(translatePgError(original)).toBe(original);
    });
  });
});
