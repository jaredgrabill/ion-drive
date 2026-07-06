/**
 * CHECK constraint rendering for field constraints (Phase 10 / ADR-017 rule 1:
 * anything Postgres can enforce lives in Postgres).
 *
 * `FieldConstraints` (min/max/pattern/enumValues) used to be advisory metadata;
 * this module turns them into named CHECK constraints so even manual SQL
 * writes cannot violate field rules. Naming convention:
 * `ion_ck_<table>_<column>_<kind>` — the prefix is how sync/drop finds them.
 *
 * Semantics by type family:
 * - numbers → value bounds (`"col" >= min`)
 * - text-like → `char_length()` bounds
 * - pattern → POSIX regex match (`~`)
 * - enumValues → `IN (...)` for single select, `<@ ARRAY[...]` for multi select
 *
 * All expressions pass on NULL (SQL three-valued logic), so required-ness stays
 * NOT NULL's job.
 */

import { COLUMN_TYPES, type ColumnTypeName, type FieldConstraints } from './types.js';

export interface CheckConstraintSpec {
  /** Constraint name: `ion_ck_<table>_<column>_<kind>`. */
  name: string;
  kind: 'min' | 'max' | 'pattern' | 'enum';
  /** SQL boolean expression the constraint enforces. */
  expression: string;
}

/** Prefix used to find Ion-managed CHECK constraints for a column. */
export function checkConstraintPrefix(tableName: string, columnName: string): string {
  return `ion_ck_${tableName}_${columnName}_`;
}

/** SQL-escapes a string literal (single-quote doubling). */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  'integer',
  'big_integer',
  'decimal',
  'float',
  'percentage',
  'currency',
  'rating',
]);

/** Types where min/max mean character length and pattern applies. */
function isTextLike(columnType: ColumnTypeName): boolean {
  const category = COLUMN_TYPES[columnType].category;
  return category === 'text' || columnType === 'enum' || columnType === 'color';
}

/**
 * Renders a field's constraints into CHECK constraint specs for its type.
 * Constraint kinds that don't apply to the type (e.g. `pattern` on a number)
 * are silently skipped — the metadata may carry them, but rule 1 says only
 * what Postgres can enforce gets enforced.
 */
export function buildCheckConstraints(
  tableName: string,
  columnName: string,
  columnType: ColumnTypeName,
  constraints: FieldConstraints | undefined,
): CheckConstraintSpec[] {
  if (!constraints) return [];
  const prefix = checkConstraintPrefix(tableName, columnName);
  const col = `"${columnName}"`;
  const numeric = NUMERIC_TYPES.has(columnType);
  const textLike = isTextLike(columnType);

  const specs = [
    boundSpec('min', constraints.min, { prefix, col, numeric, textLike }),
    boundSpec('max', constraints.max, { prefix, col, numeric, textLike }),
    patternSpec(constraints.pattern, { prefix, col, textLike }),
    enumSpec(constraints.enumValues, columnType, { prefix, col, textLike }),
  ];
  return specs.filter((s): s is CheckConstraintSpec => s !== undefined);
}

/**
 * Renders a min/max bound: a value bound for numeric types, a `char_length()`
 * bound for text-like types, nothing for types where bounds don't apply.
 */
function boundSpec(
  kind: 'min' | 'max',
  bound: number | undefined,
  ctx: { prefix: string; col: string; numeric: boolean; textLike: boolean },
): CheckConstraintSpec | undefined {
  if (bound === undefined || !(ctx.numeric || ctx.textLike)) return undefined;
  const op = kind === 'min' ? '>=' : '<=';
  return {
    name: `${ctx.prefix}${kind}`,
    kind,
    expression: ctx.numeric
      ? `${ctx.col} ${op} ${bound}`
      : `char_length(${ctx.col}) ${op} ${bound}`,
  };
}

/** Renders a POSIX regex match constraint (text-like types only). */
function patternSpec(
  pattern: string | undefined,
  ctx: { prefix: string; col: string; textLike: boolean },
): CheckConstraintSpec | undefined {
  if (!pattern || !ctx.textLike) return undefined;
  return {
    name: `${ctx.prefix}pattern`,
    kind: 'pattern',
    expression: `${ctx.col} ~ ${literal(pattern)}`,
  };
}

/**
 * Renders enum membership: `<@ ARRAY[...]` containment for multi_enum,
 * `IN (...)` for single-select text-like types.
 */
function enumSpec(
  enumValues: string[] | undefined,
  columnType: ColumnTypeName,
  ctx: { prefix: string; col: string; textLike: boolean },
): CheckConstraintSpec | undefined {
  if (!enumValues || enumValues.length === 0) return undefined;
  const values = enumValues.map(literal).join(', ');
  if (columnType === 'multi_enum') {
    return {
      name: `${ctx.prefix}enum`,
      kind: 'enum',
      expression: `${ctx.col} <@ ARRAY[${values}]::TEXT[]`,
    };
  }
  if (ctx.textLike) {
    return {
      name: `${ctx.prefix}enum`,
      kind: 'enum',
      expression: `${ctx.col} IN (${values})`,
    };
  }
  return undefined;
}
