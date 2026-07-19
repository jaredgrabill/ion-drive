/**
 * Composite unique-constraint helpers (`constraints.uniqueTogether`, issue #9).
 *
 * A uniqueTogether group is a set of two or more field names that must be
 * unique together — the natural idempotency-key shape (`unique(room_code,
 * seed)`). This module is the single source of truth for resolving and
 * normalizing groups:
 *
 *   - field names resolve to physical column names (field name or columnName
 *     both accepted, matching the data layer's lenient addressing)
 *   - columns within a group are sorted, and groups themselves are sorted, so
 *     stored metadata, constraint names, and snapshot exports are all
 *     deterministic and comparable
 *
 * The ChangeValidator validates groups, the SchemaManager applies them (DDL +
 * metadata), the snapshot round-trips them, and DataService.upsert accepts
 * them as conflict targets.
 */

import type { FieldDefinition } from './types.js';

/** Outcome of resolving raw uniqueTogether input against an object's fields. */
export interface UniqueTogetherResolution {
  /** Normalized groups: column names, sorted within and across groups. */
  groups: string[][];
  /** Human-readable problems; the input is invalid when non-empty. */
  errors: string[];
}

/** Canonical comparison key of one group (order-insensitive). */
export function groupKey(group: string[]): string {
  return [...group].sort().join(',');
}

/**
 * Resolves raw uniqueTogether groups to normalized column-name groups,
 * collecting every validation problem instead of failing fast (the
 * ChangeValidator reports them all at once).
 */
export function resolveUniqueTogether(
  groups: string[][] | undefined,
  fields: FieldDefinition[],
): UniqueTogetherResolution {
  const errors: string[] = [];
  const resolved: string[][] = [];
  const seen = new Set<string>();

  for (const group of groups ?? []) {
    const outcome = resolveGroup(group, fields);
    if ('error' in outcome) {
      errors.push(outcome.error);
      continue;
    }
    const key = outcome.columns.join(',');
    if (seen.has(key)) {
      errors.push(`uniqueTogether group [${group.join(', ')}] is declared more than once`);
      continue;
    }
    seen.add(key);
    resolved.push(outcome.columns);
  }

  resolved.sort((a, b) => groupKey(a).localeCompare(groupKey(b)));
  return { groups: resolved, errors };
}

/** Resolves one raw group to sorted column names, or a single problem. */
function resolveGroup(
  group: string[],
  fields: FieldDefinition[],
): { columns: string[] } | { error: string } {
  if (!Array.isArray(group) || group.length < 2) {
    return {
      error: `uniqueTogether group [${(group ?? []).join(', ')}] must name at least two fields (use isUnique for single-field uniqueness)`,
    };
  }

  const columns: string[] = [];
  for (const name of group) {
    const field = fields.find((f) => f.name === name || f.columnName === name);
    if (!field) {
      return { error: `uniqueTogether group [${group.join(', ')}] names unknown field "${name}"` };
    }
    columns.push(field.columnName);
  }

  const sorted = [...new Set(columns)].sort();
  if (sorted.length !== group.length) {
    return { error: `uniqueTogether group [${group.join(', ')}] contains duplicate fields` };
  }
  return { columns: sorted };
}

/**
 * Splits target groups against current groups into the added/removed delta
 * (both sides expected normalized — see {@link resolveUniqueTogether}).
 */
export function diffUniqueTogether(
  current: string[][],
  target: string[][],
): { added: string[][]; removed: string[][] } {
  const currentKeys = new Set(current.map(groupKey));
  const targetKeys = new Set(target.map(groupKey));
  return {
    added: target.filter((g) => !currentKeys.has(groupKey(g))),
    removed: current.filter((g) => !targetKeys.has(groupKey(g))),
  };
}

/**
 * Whether a set of column names matches one of the object's uniqueTogether
 * groups (order-insensitive). Used by upsert conflict-target validation.
 */
export function matchesUniqueTogether(columns: string[], groups: string[][] | undefined): boolean {
  const key = groupKey(columns);
  return (groups ?? []).some((g) => groupKey(g) === key);
}
