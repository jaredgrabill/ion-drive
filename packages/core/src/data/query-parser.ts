/**
 * Query Parser — Translates HTTP query parameters into structured QueryOptions.
 *
 * Supports a clean, intuitive query syntax:
 *   GET /api/v1/data/contacts?name[like]=John&age[gte]=21&sort=-created_at&page=2&pageSize=25&expand=company
 *
 * Filter syntax:  field[operator]=value  — e.g. name[neq]=John&date[gt]=2020-10-10
 *   Operators are case-insensitive (`[NEQ]` == `[neq]`) and accept common
 *   aliases (`ne`→neq, `<>`→neq, `=`→eq, `>`→gt, `>=`→gte, `<`→lt, `<=`→lte,
 *   `contains`→ilike, `notin`→nin, `null`→is_null, `notnull`→is_not_null).
 *   A bare `field=value` implies equality.
 * Search syntax:  search=term  (alias: q=term) — case-insensitive match across
 *   all text-like columns of the object; combined with filters via AND.
 * Sort syntax:    sort=field (asc) or sort=-field (desc), comma-separated
 * Pagination:     page=N&pageSize=N
 * Expand:         expand=rel1,rel2
 * Select:         select=field1,field2
 */

import type {
  AggregateOptions,
  FilterCondition,
  FilterOperator,
  PaginationOptions,
  QueryOptions,
  SortOption,
} from './types.js';

/**
 * Canonical operators keyed by every accepted spelling (lowercased). Symbolic
 * and shorthand aliases let clients write natural query strings without needing
 * to memorise the canonical names.
 */
const OPERATOR_ALIASES: Record<string, FilterOperator> = {
  eq: 'eq',
  '=': 'eq',
  '==': 'eq',
  neq: 'neq',
  ne: 'neq',
  '!=': 'neq',
  '<>': 'neq',
  gt: 'gt',
  '>': 'gt',
  gte: 'gte',
  '>=': 'gte',
  lt: 'lt',
  '<': 'lt',
  lte: 'lte',
  '<=': 'lte',
  like: 'like',
  ilike: 'ilike',
  contains: 'ilike',
  in: 'in',
  nin: 'nin',
  notin: 'nin',
  is_null: 'is_null',
  null: 'is_null',
  isnull: 'is_null',
  is_not_null: 'is_not_null',
  notnull: 'is_not_null',
  isnotnull: 'is_not_null',
};

/** Query-string keys with reserved meaning — never treated as filters. */
const RESERVED_KEYS = new Set([
  'sort',
  'page',
  'pageSize',
  'limit',
  'offset',
  'expand',
  'select',
  'search',
  'q',
]);

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Parses raw query string parameters into a structured QueryOptions object.
 */
export function parseQueryParams(query: Record<string, unknown>): QueryOptions {
  return {
    filters: parseFilters(query),
    search: parseSearch(query),
    sort: parseSort(query),
    pagination: parsePagination(query),
    expand: parseExpand(query),
    select: parseSelect(query),
  };
}

/** The aggregate endpoint's own query keys — not filters there. */
const AGGREGATE_KEYS = new Set(['fn', 'field']);

/**
 * Parses the query string of the aggregate endpoint
 * (`GET /api/v1/data/:object/aggregate?fn=avg&field=damage&…`).
 *
 * `fn` and `field` address the aggregate itself; everything else is the same
 * filter + search grammar as the list endpoint (sort/pagination keys are
 * accepted but meaningless for a scalar result, so they are dropped). A column
 * literally named `fn` or `field` can still be filtered with explicit operator
 * syntax (`fn[eq]=…`) — only the bare keys are reserved here.
 */
export function parseAggregateParams(query: Record<string, unknown>): {
  fn?: string;
  field?: string;
  options: AggregateOptions;
} {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!AGGREGATE_KEYS.has(key)) rest[key] = value;
  }
  const fn = typeof query.fn === 'string' && query.fn.trim() !== '' ? query.fn.trim() : undefined;
  const field =
    typeof query.field === 'string' && query.field.trim() !== '' ? query.field.trim() : undefined;
  return {
    fn,
    field,
    options: { filters: parseFilters(rest), search: parseSearch(rest) },
  };
}

/**
 * Parses filter conditions from query params.
 * Format: field[operator]=value  (operator case-insensitive, aliases accepted)
 * Shorthand: field=value (implies eq)
 */
function parseFilters(query: Record<string, unknown>): FilterCondition[] {
  const filters: FilterCondition[] = [];

  for (const [key, rawValue] of Object.entries(query)) {
    if (RESERVED_KEYS.has(key) || rawValue === undefined || rawValue === '') continue;
    const condition = parseFilterEntry(key, rawValue);
    if (condition) filters.push(condition);
  }

  return filters;
}

/**
 * Parses a single `field[operator]=value` query entry into a FilterCondition.
 * Returns undefined when the key is not filter-shaped or names an unknown
 * operator (such entries are silently ignored, matching prior behavior).
 */
function parseFilterEntry(key: string, rawValue: unknown): FilterCondition | undefined {
  // Check for operator syntax: field[operator]. The operator is matched
  // permissively (letters, underscores, and comparison symbols) then
  // normalised through the alias table.
  const match = key.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\[([^\]]+)\])?$/);
  if (!match) return undefined;

  const field = match[1] as string;
  const rawOperator = (match[2] ?? 'eq').trim().toLowerCase();
  const operator = OPERATOR_ALIASES[rawOperator];
  if (!operator) return undefined;

  return { field, operator, value: coerceFilterValue(operator, rawValue) };
}

/**
 * Coerces a raw filter value according to its operator: list operators split
 * on commas (each item coerced), null-check operators carry no value, and
 * plain string values are coerced to number/boolean/null when they look like one.
 */
function coerceFilterValue(operator: FilterOperator, rawValue: unknown): unknown {
  if (operator === 'in' || operator === 'nin') {
    // Comma-separated values, each coerced to number/boolean/null when it looks like one
    return String(rawValue)
      .split(',')
      .map((v) => coerceValue(v.trim()));
  }
  if (operator === 'is_null' || operator === 'is_not_null') {
    return null;
  }
  if (typeof rawValue === 'string') {
    // Try to parse as number or boolean
    return coerceValue(rawValue);
  }
  return rawValue;
}

/**
 * Parses the free-text search term. Accepts `search=` or the shorthand `q=`.
 * Returns undefined when neither is present or the term is blank.
 */
function parseSearch(query: Record<string, unknown>): string | undefined {
  const raw = query.search ?? query.q;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parses sort options from the sort query param.
 * Format: sort=field1,-field2 (prefix with - for desc)
 */
function parseSort(query: Record<string, unknown>): SortOption[] {
  const sortParam = query.sort;
  if (!sortParam || typeof sortParam !== 'string') return [];

  return sortParam.split(',').map((s) => {
    const trimmed = s.trim();
    if (trimmed.startsWith('-')) {
      return { field: trimmed.slice(1), direction: 'desc' as const };
    }
    return { field: trimmed, direction: 'asc' as const };
  });
}

/**
 * Parses pagination options. Supports both the page-based interface
 * (`page`/`pageSize`) and offset-based pagination (`limit`/`offset`,
 * Supabase/PostgREST-style). When present, `limit`/`offset` win — see
 * `DataService.list`.
 */
function parsePagination(query: Record<string, unknown>): PaginationOptions {
  const page = Math.max(1, Number(query.page) || 1);
  const rawPageSize = Number(query.pageSize) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, rawPageSize), MAX_PAGE_SIZE);

  const result: PaginationOptions = { page, pageSize };

  if (query.limit !== undefined && query.limit !== '') {
    const rawLimit = Number(query.limit);
    if (!Number.isNaN(rawLimit)) {
      result.limit = Math.min(Math.max(1, Math.trunc(rawLimit)), MAX_PAGE_SIZE);
    }
  }
  if (query.offset !== undefined && query.offset !== '') {
    const rawOffset = Number(query.offset);
    if (!Number.isNaN(rawOffset)) {
      result.offset = Math.max(0, Math.trunc(rawOffset));
    }
  }

  return result;
}

/**
 * Parses relationship expansion.
 * Format: expand=rel1,rel2
 */
function parseExpand(query: Record<string, unknown>): string[] {
  const expand = query.expand;
  if (!expand || typeof expand !== 'string') return [];
  return expand
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses field selection.
 * Format: select=field1,field2
 */
function parseSelect(query: Record<string, unknown>): string[] {
  const select = query.select;
  if (!select || typeof select !== 'string') return [];
  return select
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Coerce string values to appropriate types.
 */
function coerceValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;

  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== '') return num;

  return value;
}
