/**
 * Atomic update operators (issue #9) — the `{ "$inc": n }` / `{ "$dec": n }`
 * value shape accepted by update writes.
 *
 * A counter-style PATCH like `{ "wins": { "$inc": 1 } }` must compile to
 * `SET wins = wins + 1` in a single UPDATE statement so concurrent writers
 * never lose updates (read-modify-write is the bug this exists to fix). This
 * module only *classifies and validates* the input; the SQL expression is
 * built by DataService so the operator shape stays surface-agnostic (REST
 * bodies, the GraphQL `increment` argument, and the MCP `increment` parameter
 * all funnel into the same split).
 *
 * Rules:
 *   - a value is an operator iff it is a plain object carrying a `$`-prefixed
 *     key; `$inc: n` adds n (negative n subtracts), `$dec: n` is sugar for
 *     `$inc: -n`
 *   - operators only apply to numeric columns (number category + rating);
 *     anything else is a 400
 *   - mixed shapes (`{ $inc: 1, extra: 2 }`), unknown operators, and
 *     non-numeric amounts are 400s — never silently written
 *   - `json` (structured) columns are exempt from operator detection: an
 *     object value there is data, and `{"$inc": 1}` is a legal JSON document
 */

import { COLUMN_TYPES, type FieldDefinition } from '../schema/types.js';
import { DataServiceError } from './errors.js';

/** An update body split into plain assignments and atomic increments. */
export interface SplitUpdate {
  /** Plain `col = value` assignments (column-keyed, like sanitized input). */
  sets: Record<string, unknown>;
  /** Atomic `col = col + n` increments (signed; `$dec` already negated). */
  increments: Record<string, number>;
}

/** Whether a column type supports arithmetic increments. */
export function isNumericColumn(columnType: string): boolean {
  return (
    COLUMN_TYPES[columnType as keyof typeof COLUMN_TYPES]?.category === 'number' ||
    columnType === 'rating'
  );
}

/** Whether a value carries any `$`-operator key (plain objects only). */
function hasOperatorKeys(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).some((k) => k.startsWith('$'))
  );
}

/**
 * Rejects atomic operators aimed at columns `sanitizeInput` would silently
 * drop (issue #23): system/primary columns (`id`, `created_at`, `created_by`,
 * `updated_at`, `updated_by`) and unknown fields. Runs against the **raw**
 * update body, before sanitization erases the evidence.
 *
 * Plain values on those keys keep the data layer's lenient drop-unknowns
 * contract — but an explicit `{ "$inc": n }` is a statement of intent, and
 * silently no-opping it turns a typo'd counter bump into a 200 that updated
 * nothing. `json` columns stay exempt for the same reason as in
 * {@link splitAtomicOperations}: an object value there is data — but a system
 * or unknown key can never be a writable json column, so the check holds.
 *
 * `keepPrimary` mirrors the sanitizer's upsert mode: a kept primary key is
 * writable there, and a `$inc` on it then fails the numeric-column rule in
 * {@link splitAtomicOperations} instead.
 */
export function assertOperatorTargetsWritable(
  fields: FieldDefinition[],
  rawData: Record<string, unknown>,
  options: { keepPrimary?: boolean } = {},
): void {
  for (const [key, value] of Object.entries(rawData)) {
    if (!hasOperatorKeys(value)) continue;
    const field = fields.find((f) => f.name === key || f.columnName === key);
    if (!field) {
      throw new DataServiceError(
        `Cannot apply atomic operators to unknown field "${key}"`,
        'INVALID_ATOMIC_OP',
        400,
        key,
      );
    }
    const writable =
      (!field.isSystem && !field.isPrimary) ||
      (options.keepPrimary === true && field.isPrimary === true);
    if (!writable) {
      throw new DataServiceError(
        `Cannot apply atomic operators to system field "${field.name}"`,
        'INVALID_ATOMIC_OP',
        400,
        field.name,
      );
    }
  }
}

/**
 * Splits sanitized (column-keyed) update data into plain sets and atomic
 * increments, validating operator shapes against the object's fields. Throws
 * a typed 400 {@link DataServiceError} on any malformed operator.
 */
export function splitAtomicOperations(
  fields: FieldDefinition[],
  cleanData: Record<string, unknown>,
): SplitUpdate {
  const sets: Record<string, unknown> = {};
  const increments: Record<string, number> = {};

  for (const [column, value] of Object.entries(cleanData)) {
    const field = fields.find((f) => f.columnName === column);
    const isJson = field ? COLUMN_TYPES[field.columnType]?.category === 'structured' : false;

    if (!hasOperatorKeys(value) || isJson) {
      sets[column] = value;
      continue;
    }

    increments[column] = parseOperator(field, column, value);
  }

  return { sets, increments };
}

/** Validates one operator object and returns its signed increment amount. */
function parseOperator(
  field: FieldDefinition | undefined,
  column: string,
  value: Record<string, unknown>,
): number {
  const keys = Object.keys(value);
  const fieldName = field?.name ?? column;

  if (keys.length !== 1 || (keys[0] !== '$inc' && keys[0] !== '$dec')) {
    throw new DataServiceError(
      `Invalid atomic operation on "${fieldName}": expected exactly one of "$inc" or "$dec" (got ${keys.join(', ') || 'an empty object'})`,
      'INVALID_ATOMIC_OP',
      400,
    );
  }

  const op = keys[0] as '$inc' | '$dec';
  const amount = value[op];
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new DataServiceError(
      `Invalid atomic operation on "${fieldName}": "${op}" requires a finite number (got ${JSON.stringify(amount)})`,
      'INVALID_ATOMIC_OP',
      400,
    );
  }

  if (!field || !isNumericColumn(field.columnType)) {
    throw new DataServiceError(
      `Cannot apply "${op}" to "${fieldName}": atomic increments require a numeric column (got ${field?.columnType ?? 'unknown'})`,
      'INVALID_ATOMIC_OP',
      400,
    );
  }

  return op === '$dec' ? -amount : amount;
}
