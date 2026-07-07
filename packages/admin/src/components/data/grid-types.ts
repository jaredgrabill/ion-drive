/**
 * Grid types — shared vocabulary for the DataGrid component family.
 *
 * Maps Ion Drive column types to UI categories (alignment, icon, editor
 * kind), defines the filter/sort models used by FilterBuilder/SortBuilder,
 * and serializes them into the Phase 7 REST query syntax
 * (`field[op]=value`, `q=`, `sort=-field`, `page`/`pageSize`).
 */

export type GridRow = Record<string, unknown>;

// --- Column type categories -------------------------------------------

/** How a column edits/renders; derived from the backend column type. */
export type CellKind =
  | 'text'
  | 'longText'
  | 'number'
  | 'currency'
  | 'percentage'
  | 'rating'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'uuid'
  | 'json'
  | 'email'
  | 'url';

const KIND_BY_COLUMN_TYPE: Record<string, CellKind> = {
  text: 'text',
  short_text: 'text',
  long_text: 'longText',
  rich_text: 'longText',
  integer: 'number',
  big_integer: 'number',
  decimal: 'number',
  float: 'number',
  currency: 'currency',
  percentage: 'percentage',
  rating: 'rating',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
  timestamp: 'datetime',
  enum: 'enum',
  uuid: 'uuid',
  json: 'json',
  email: 'email',
  url: 'url',
};

/** Resolves a backend column type to its UI cell kind (default: text). */
export function cellKindOf(columnType: string): CellKind {
  return KIND_BY_COLUMN_TYPE[columnType] ?? 'text';
}

/** Kinds that are edited as numbers (input type="number", right-aligned). */
export const NUMERIC_KINDS: ReadonlySet<CellKind> = new Set([
  'number',
  'currency',
  'percentage',
  'rating',
]);

/** Kinds edited in a side sheet rather than inline (too big for a cell). */
export const SHEET_EDIT_KINDS: ReadonlySet<CellKind> = new Set(['longText', 'json']);

// --- Linked-record fields (Phase 10 / Tier 3) ---------------------------

import type {
  DataObjectDefinition,
  FieldDefinition,
  RelationshipDefinition,
} from '../../lib/types';

/**
 * Resolves the relationship behind a FK field on this object, if any.
 * A field `company_id` is a link field when a relationship named `company`
 * exists and this object is the side holding the FK column.
 */
export function linkedRelationshipOf(
  object: DataObjectDefinition,
  field: FieldDefinition,
): RelationshipDefinition | null {
  if (!field.name.endsWith('_id')) return null;
  const relName = field.name.slice(0, -3);
  const rel = (object.relationships ?? []).find((r) => r.name === relName);
  if (!rel || rel.type === 'many_to_many') return null;
  const holdsFk =
    rel.type === 'one_to_many'
      ? rel.targetObjectName === object.name
      : rel.sourceObjectName === object.name;
  return holdsFk ? rel : null;
}

/**
 * The object's many_to_many relationships — the grid's chip columns and the
 * RecordSheet's linked-record editors (Phase 13). De-duplicated by name (a
 * self-referential rel would otherwise appear twice).
 */
export function m2mRelationshipsOf(object: DataObjectDefinition): RelationshipDefinition[] {
  const seen = new Set<string>();
  return (object.relationships ?? []).filter((rel) => {
    if (rel.type !== 'many_to_many' || seen.has(rel.name)) return false;
    seen.add(rel.name);
    return true;
  });
}

/** The object a link field points at (the "other side"). */
export function linkTargetOf(object: DataObjectDefinition, rel: RelationshipDefinition): string {
  return rel.type === 'one_to_many'
    ? rel.sourceObjectName
    : rel.targetObjectName === object.name
      ? rel.sourceObjectName
      : rel.targetObjectName;
}

// --- Filters -----------------------------------------------------------

/** Operators offered in the FilterBuilder, mapped 1:1 to REST operators. */
export interface FilterOperatorDef {
  /** REST operator name (goes into `field[op]=`). */
  op: string;
  label: string;
  /** Whether the operator takes a value input. */
  hasValue: boolean;
}

const TEXT_OPERATORS: FilterOperatorDef[] = [
  { op: 'eq', label: 'equals', hasValue: true },
  { op: 'neq', label: 'not equals', hasValue: true },
  { op: 'contains', label: 'contains', hasValue: true },
  { op: 'in', label: 'is any of', hasValue: true },
  { op: 'null', label: 'is empty', hasValue: false },
  { op: 'notnull', label: 'is not empty', hasValue: false },
];

const NUMBER_OPERATORS: FilterOperatorDef[] = [
  { op: 'eq', label: '=', hasValue: true },
  { op: 'neq', label: '≠', hasValue: true },
  { op: 'gt', label: '>', hasValue: true },
  { op: 'gte', label: '≥', hasValue: true },
  { op: 'lt', label: '<', hasValue: true },
  { op: 'lte', label: '≤', hasValue: true },
  { op: 'null', label: 'is empty', hasValue: false },
  { op: 'notnull', label: 'is not empty', hasValue: false },
];

const BOOLEAN_OPERATORS: FilterOperatorDef[] = [
  { op: 'eq', label: 'is', hasValue: true },
  { op: 'null', label: 'is empty', hasValue: false },
];

/** Operators applicable to a given cell kind. */
export function operatorsFor(kind: CellKind): FilterOperatorDef[] {
  if (NUMERIC_KINDS.has(kind) || kind === 'date' || kind === 'datetime') return NUMBER_OPERATORS;
  if (kind === 'boolean') return BOOLEAN_OPERATORS;
  return TEXT_OPERATORS;
}

/** One active filter condition (field → operator → value). */
export interface FilterCondition {
  field: string;
  op: string;
  value: string;
}

/** One active sort rule. */
export interface SortRule {
  field: string;
  direction: 'asc' | 'desc';
}

// --- Query serialization ------------------------------------------------

export interface GridQuery {
  page: number;
  pageSize: number;
  search: string;
  filters: FilterCondition[];
  sorts: SortRule[];
  /** Relation keys to expand (the grid's m2m chip columns — Phase 13). */
  expand?: string[];
}

/** Serializes the grid state into the Phase 7 REST query string. */
export function buildQueryString(query: GridQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.expand?.length) params.set('expand', query.expand.join(','));
  if (query.search) params.set('q', query.search);
  if (query.sorts.length > 0) {
    params.set(
      'sort',
      query.sorts.map((s) => (s.direction === 'desc' ? `-${s.field}` : s.field)).join(','),
    );
  }
  for (const filter of query.filters) {
    if (!filter.field || !filter.op) continue;
    params.append(`${filter.field}[${filter.op}]`, filter.value);
  }
  return `?${params.toString()}`;
}
