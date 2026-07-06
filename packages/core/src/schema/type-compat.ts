/**
 * Compatible-type matrix for field type changes (Phase 10 / ADR-017).
 *
 * `assessTypeChange(from, to)` answers, for a proposed `ALTER COLUMN ... TYPE`:
 * is the conversion allowed, is it lossless (`safe`) or potentially lossy
 * (`warn`), what data pre-check must the ChangeValidator run against existing
 * rows before allowing it, and what `USING` cast (if any) the DDL needs.
 *
 * The matrix is deliberately conservative: only conversions with a predictable
 * Postgres cast are allowed; everything else is a hard incompatibility. Rules
 * are family-driven (text-like limits, numeric ranges) rather than a literal
 * N×N table, with the same outcome: an explicit, testable decision per pair.
 */

import { COLUMN_TYPES, type ColumnTypeName } from './types.js';

// ---------------------------------------------------------------------------
// Assessment result types
// ---------------------------------------------------------------------------

/** Data pre-check the validator must run before permitting the conversion. */
export type TypeChangePrecheck =
  /** Existing values must fit in `limit` characters (text narrowing). */
  | { kind: 'max_text_length'; limit: number }
  /** Existing values must fall inside [min, max] (numeric narrowing). */
  | { kind: 'numeric_range'; min: number; max: number };

export type TypeChangeAssessment =
  | { compatible: false; reason: string }
  | {
      compatible: true;
      level: 'safe' | 'warn';
      /** Human-readable caveat when level is 'warn'. */
      message?: string;
      precheck?: TypeChangePrecheck;
      /**
       * `USING` cast for the ALTER (e.g. `::TEXT`). Omitted when Postgres has
       * an assignment cast — deliberately omitted for text narrowing so PG
       * raises on overflow instead of silently truncating via an explicit cast.
       */
      usingCast?: string;
    };

// ---------------------------------------------------------------------------
// Type families
// ---------------------------------------------------------------------------

/**
 * Character limit of a text-like type, or null for unlimited (TEXT).
 * Derived from the declared PG type so the matrix can never drift from DDL.
 */
export function textLimit(type: ColumnTypeName): number | null {
  const pg = COLUMN_TYPES[type].pg;
  const match = /^VARCHAR\((\d+)\)$/i.exec(pg);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** Types stored as VARCHAR/TEXT — freely inter-convertible subject to length. */
const TEXT_LIKE: ReadonlySet<ColumnTypeName> = new Set([
  'text',
  'short_text',
  'long_text',
  'rich_text',
  'email',
  'url',
  'phone',
  'slug',
  'enum',
  'color',
]);

/** Value range of each numeric type (what the storage can represent). */
const NUMERIC_RANGE: Partial<Record<ColumnTypeName, { min: number; max: number }>> = {
  rating: { min: -32768, max: 32767 }, // SMALLINT
  integer: { min: -2147483648, max: 2147483647 },
  big_integer: { min: -(2 ** 63), max: 2 ** 63 - 1 },
  // NUMERIC(19,4): 15 integer digits. The bound is used for range pre-checks,
  // so the (double-representable) 1e15 approximation is sufficient.
  decimal: { min: -1e15, max: 1e15 },
  currency: { min: -1e15, max: 1e15 },
  percentage: { min: -999.99, max: 999.99 }, // NUMERIC(5,2)
  float: { min: -Number.MAX_VALUE, max: Number.MAX_VALUE },
};

/** Whether the numeric type stores fractional digits. */
const HAS_FRACTION: ReadonlySet<ColumnTypeName> = new Set([
  'decimal',
  'currency',
  'percentage',
  'float',
]);

/** Types that can always be rendered to text with an explicit `::text` cast. */
const TEXT_RENDERABLE: ReadonlySet<ColumnTypeName> = new Set([
  'integer',
  'big_integer',
  'decimal',
  'float',
  'percentage',
  'currency',
  'rating',
  'boolean',
  'date',
  'datetime',
  'time',
  'uuid',
  'json',
  'ip_address',
]);

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** Assesses converting a column from one Ion Drive type to another. */
export function assessTypeChange(from: ColumnTypeName, to: ColumnTypeName): TypeChangeAssessment {
  if (from === to) return { compatible: true, level: 'safe' };

  if (TEXT_LIKE.has(from) && TEXT_LIKE.has(to)) return assessTextToText(from, to);
  if (NUMERIC_RANGE[from] && NUMERIC_RANGE[to]) return assessNumberToNumber(from, to);
  if (TEXT_RENDERABLE.has(from) && TEXT_LIKE.has(to)) return assessToText(from, to);

  // Same physical type (TEXT[]) — pure relabel.
  if (
    (from === 'multi_enum' && to === 'array_text') ||
    (from === 'array_text' && to === 'multi_enum')
  ) {
    return { compatible: true, level: 'safe' };
  }
  if (from === 'array_integer' && to === 'array_text') {
    return { compatible: true, level: 'safe', usingCast: '::TEXT[]' };
  }
  // Timestamps: widening is safe, narrowing discards the time of day.
  if (from === 'date' && to === 'datetime') return { compatible: true, level: 'safe' };
  if (from === 'datetime' && to === 'date') {
    return {
      compatible: true,
      level: 'warn',
      message: 'Converting timestamps to dates discards the time of day for every existing row.',
    };
  }

  return {
    compatible: false,
    reason: `Cannot convert "${COLUMN_TYPES[from].label}" (${COLUMN_TYPES[from].pg}) to "${COLUMN_TYPES[to].label}" (${COLUMN_TYPES[to].pg}). Create a new field and migrate the data instead.`,
  };
}

function assessTextToText(from: ColumnTypeName, to: ColumnTypeName): TypeChangeAssessment {
  const fromLimit = textLimit(from);
  const toLimit = textLimit(to);
  // Widening (or equal limits) never loses data. No USING needed: varchar/text
  // have assignment casts.
  if (toLimit === null || (fromLimit !== null && toLimit >= fromLimit)) {
    return { compatible: true, level: 'safe' };
  }
  return {
    compatible: true,
    level: 'warn',
    message: `"${COLUMN_TYPES[to].label}" holds at most ${toLimit} characters; longer existing values would block the change.`,
    precheck: { kind: 'max_text_length', limit: toLimit },
  };
}

function assessNumberToNumber(from: ColumnTypeName, to: ColumnTypeName): TypeChangeAssessment {
  // biome-ignore lint/style/noNonNullAssertion: both keys checked by caller
  const fromRange = NUMERIC_RANGE[from]!;
  // biome-ignore lint/style/noNonNullAssertion: both keys checked by caller
  const toRange = NUMERIC_RANGE[to]!;
  const cast = `::${COLUMN_TYPES[to].pg}`;

  const narrows = toRange.min > fromRange.min || toRange.max < fromRange.max;
  const losesFraction = HAS_FRACTION.has(from) && !HAS_FRACTION.has(to);
  const losesPrecision = from === 'big_integer' && to === 'float';

  if (!narrows && !losesFraction && !losesPrecision) {
    return { compatible: true, level: 'safe', usingCast: cast };
  }

  const caveats: string[] = [];
  if (narrows) {
    caveats.push(`values outside ${toRange.min}..${toRange.max} would block the change`);
  }
  if (losesFraction) caveats.push('fractional digits will be rounded');
  if (losesPrecision) caveats.push('very large values may lose precision');

  return {
    compatible: true,
    level: 'warn',
    message: `Converting to "${COLUMN_TYPES[to].label}": ${caveats.join('; ')}.`,
    precheck: narrows ? { kind: 'numeric_range', ...toRange } : undefined,
    usingCast: cast,
  };
}

function assessToText(from: ColumnTypeName, to: ColumnTypeName): TypeChangeAssessment {
  const toLimit = textLimit(to);
  // Rendered numbers/dates/uuids stay under 40 chars; JSON can be arbitrarily long.
  const mayOverflow = toLimit !== null && (from === 'json' || toLimit < 40);
  if (!mayOverflow) {
    return { compatible: true, level: 'safe', usingCast: '::TEXT' };
  }
  return {
    compatible: true,
    level: 'warn',
    message: `Rendered values longer than ${toLimit} characters would block the change.`,
    precheck: { kind: 'max_text_length', limit: toLimit ?? 0 },
    usingCast: '::TEXT',
  };
}
