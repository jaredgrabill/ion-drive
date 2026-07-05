/**
 * Change diffing for CRUD events.
 *
 * {@link computeDiff} produces a shallow field-level diff between a record's
 * before- and after-images: `{ field: { before, after } }` for every column
 * whose value changed. System-managed columns (`created_at`/`updated_at`, and
 * future `*_by`) are **always excluded** — a diff reflects business changes
 * only, never platform bookkeeping (a hard requirement from ADR-015). Values
 * are compared structurally (JSON) so object/array columns diff correctly.
 */

import { SYSTEM_MANAGED_COLUMNS } from '../schema/types.js';
import type { FieldDiff } from './event-types.js';

/**
 * Computes the field-level diff from `before` to `after`. Returns `null` when
 * nothing (outside system-managed columns) changed, so callers can omit an
 * empty diff. Keys present in either image are considered.
 */
export function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldDiff | null {
  const diff: FieldDiff = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (SYSTEM_MANAGED_COLUMNS.has(key)) continue;
    const prev = before[key];
    const next = after[key];
    if (!valuesEqual(prev, next)) {
      diff[key] = { before: prev, after: next };
    }
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Structural equality via JSON serialization. Adequate for column values
 * (scalars, dates-as-strings, jsonb objects/arrays) which are always
 * JSON-serialisable; key order within plain objects is preserved by Postgres
 * row shape, so this does not produce false diffs in practice.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return JSON.stringify(a) === JSON.stringify(b);
}
