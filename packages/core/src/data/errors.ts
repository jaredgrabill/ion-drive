/**
 * Data-layer errors and the Postgres → error-contract translation.
 *
 * `DataServiceError` is the typed error every data surface (REST, GraphQL,
 * MCP) knows how to render: a machine-readable `error` code, an HTTP status,
 * and optionally the field at fault. `translatePgError` is the single mapping
 * layer that turns the SQLSTATE classes a data write can legitimately trigger
 * (constraint violations, unparseable input) into that contract, so callers
 * see a stable 4xx instead of a raw Postgres 500 — and internal constraint
 * names never leak into responses. Errors outside those classes pass through
 * unchanged (a genuine server fault should still be a 500).
 */

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class DataServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    /** The offending column/field, when it can be determined. */
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'DataServiceError';
  }
}

// ---------------------------------------------------------------------------
// Postgres error translation
// ---------------------------------------------------------------------------

/** The subset of node-postgres's DatabaseError this mapping reads. */
interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
  column?: string;
  constraint?: string;
  table?: string;
}

/** SQLSTATEs for values Postgres could not parse as the column's type. */
const INVALID_VALUE_CODES = new Set(['22P02', '22007', '22008']);

/**
 * Extracts the column list from a constraint-violation detail such as
 * `Key (device_id)=(abc) already exists.` — the most reliable source, and it
 * handles composite keys (`Key (a, b)=…`).
 */
function fieldFromDetail(detail: string | undefined): string | undefined {
  const match = detail?.match(/Key \(([^)]+)\)=/);
  return match?.[1];
}

/**
 * Derives the column from a conventionally named constraint
 * (`players_device_id_key` → `device_id`) when the detail is unavailable.
 */
function fieldFromConstraint(
  constraint: string | undefined,
  table: string | undefined,
): string | undefined {
  if (!constraint) return undefined;
  let name = constraint;
  if (table && name.startsWith(`${table}_`)) name = name.slice(table.length + 1);
  name = name.replace(/_(key|fkey|pkey|idx|check)$/, '');
  return name || undefined;
}

/**
 * Maps a Postgres constraint/input error onto the platform error contract:
 *
 * | SQLSTATE            | HTTP | `error`                 |
 * |:--------------------|:-----|:------------------------|
 * | 23505 unique        | 409  | `unique_violation`      |
 * | 23503 foreign key   | 409  | `foreign_key_violation` |
 * | 23502 not null      | 400  | `not_null_violation`    |
 * | 22P02/22007/22008   | 400  | `invalid_value`         |
 *
 * Anything else — including errors that are not Postgres errors — is returned
 * unchanged. Messages are rebuilt from the parsed column so internal
 * constraint names never surface (Postgres puts them in `message`).
 */
export function translatePgError(err: unknown): unknown {
  if (err instanceof DataServiceError) return err;
  const pgErr = err as PgErrorLike | null;
  if (!pgErr || typeof pgErr.code !== 'string') return err;

  if (pgErr.code === '23505') return uniqueViolation(pgErr);
  if (pgErr.code === '23503') return foreignKeyViolation(pgErr);
  if (pgErr.code === '23502') return notNullViolation(pgErr);
  if (INVALID_VALUE_CODES.has(pgErr.code)) return invalidValue(pgErr);
  return err;
}

/** 23505 duplicate key → 409 `unique_violation`. */
function uniqueViolation(pgErr: PgErrorLike): DataServiceError {
  const field = fieldFromDetail(pgErr.detail) ?? fieldFromConstraint(pgErr.constraint, pgErr.table);
  return new DataServiceError(
    field
      ? `A record with this ${field} already exists`
      : 'A record with the same unique value already exists',
    'unique_violation',
    409,
    field,
  );
}

/** 23503 foreign key → 409 `foreign_key_violation` (both directions). */
function foreignKeyViolation(pgErr: PgErrorLike): DataServiceError {
  const field = fieldFromDetail(pgErr.detail);
  if (pgErr.detail?.includes('is still referenced')) {
    return new DataServiceError(
      'This record is still referenced by other records',
      'foreign_key_violation',
      409,
      field,
    );
  }
  return new DataServiceError(
    field
      ? `The record referenced by "${field}" does not exist`
      : 'The referenced record does not exist',
    'foreign_key_violation',
    409,
    field,
  );
}

/** 23502 not null → 400 `not_null_violation`. */
function notNullViolation(pgErr: PgErrorLike): DataServiceError {
  const field = pgErr.column;
  return new DataServiceError(
    field ? `Field "${field}" is required and cannot be null` : 'A required field is missing',
    'not_null_violation',
    400,
    field,
  );
}

/** 22P02/22007/22008 → 400 `invalid_value` (Postgres's message is value-safe). */
function invalidValue(pgErr: PgErrorLike): DataServiceError {
  return new DataServiceError(
    pgErr.message ?? 'A value could not be parsed as its column type',
    'invalid_value',
    400,
  );
}
