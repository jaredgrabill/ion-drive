/**
 * QueryBuilder — a fluent, type-safe builder for Ion Drive list queries.
 *
 * It produces exactly the query string the server's parser understands:
 *
 *   field[operator]=value   filters (operators + aliases)
 *   search=term             free-text search across text-like columns
 *   sort=a,-b               sort ascending / descending (`-` prefix)
 *   page / pageSize         pagination
 *   expand=rel1,rel2        relationship expansion
 *   select=f1,f2            field projection
 *
 * Example:
 *   new QueryBuilder()
 *     .where('name', 'neq', 'John')
 *     .gt('created_at', '2020-10-10')
 *     .search('acme')
 *     .sort('created_at', 'desc')
 *     .page(2)
 *     .toQueryString();
 *   // => "name[neq]=John&created_at[gt]=2020-10-10&search=acme&sort=-created_at&page=2"
 *
 * The builder is pure (no I/O); {@link IonDriveClient} composes it with fetch.
 */

import type { FilterOperator, OperatorAlias, SortDirection } from './types.js';

/** Maps every accepted spelling of an operator onto its canonical form. */
const OPERATOR_ALIASES: Record<OperatorAlias, FilterOperator> = {
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
  is_not_null: 'is_not_null',
};

interface FilterEntry {
  field: string;
  operator: FilterOperator;
  value: string;
}

interface SortEntry {
  field: string;
  direction: SortDirection;
}

/**
 * A pure builder for Ion Drive query strings. Every mutating method returns
 * `this`, so subclasses (e.g. the client's bound resource query) can chain and
 * preserve their own type.
 */
export class QueryBuilder {
  private filters: FilterEntry[] = [];
  private searchTerm?: string;
  private sorts: SortEntry[] = [];
  private pageNum?: number;
  private pageSizeNum?: number;
  private limitNum?: number;
  private offsetNum?: number;
  private expands: string[] = [];
  private selects: string[] = [];

  /**
   * Adds a filter. `operator` accepts canonical names or aliases (`ne`, `>`,
   * `contains`, …). For `in`/`nin`, pass an array; for `is_null`/`is_not_null`
   * the value is ignored.
   */
  where(field: string, operator: OperatorAlias, value?: unknown): this {
    const canonical = OPERATOR_ALIASES[operator];
    if (!canonical) throw new QueryBuilderError(`Unknown operator: ${String(operator)}`);

    let encoded: string;
    if (canonical === 'in' || canonical === 'nin') {
      const arr = Array.isArray(value) ? value : [value];
      encoded = arr.map((v) => stringifyValue(v)).join(',');
    } else if (canonical === 'is_null' || canonical === 'is_not_null') {
      // A non-empty placeholder — the server derives the value from the operator
      // but skips blank query values.
      encoded = 'true';
    } else {
      encoded = stringifyValue(value);
    }

    this.filters.push({ field, operator: canonical, value: encoded });
    return this;
  }

  // --- Operator shorthands ---------------------------------------------------
  eq(field: string, value: unknown): this {
    return this.where(field, 'eq', value);
  }
  neq(field: string, value: unknown): this {
    return this.where(field, 'neq', value);
  }
  gt(field: string, value: unknown): this {
    return this.where(field, 'gt', value);
  }
  gte(field: string, value: unknown): this {
    return this.where(field, 'gte', value);
  }
  lt(field: string, value: unknown): this {
    return this.where(field, 'lt', value);
  }
  lte(field: string, value: unknown): this {
    return this.where(field, 'lte', value);
  }
  like(field: string, value: unknown): this {
    return this.where(field, 'like', value);
  }
  ilike(field: string, value: unknown): this {
    return this.where(field, 'ilike', value);
  }
  in(field: string, values: unknown[]): this {
    return this.where(field, 'in', values);
  }
  nin(field: string, values: unknown[]): this {
    return this.where(field, 'nin', values);
  }
  isNull(field: string): this {
    return this.where(field, 'is_null');
  }
  isNotNull(field: string): this {
    return this.where(field, 'is_not_null');
  }

  /**
   * Null check, Supabase-style: `is(field, null)`. (Pass `null` — non-null
   * checks use `isNotNull()` or `not(field, 'is', null)`.)
   */
  is(field: string, value: null): this {
    if (value !== null) {
      throw new QueryBuilderError('is() only supports null; use eq()/isNotNull() otherwise');
    }
    return this.isNull(field);
  }

  /**
   * Negated filter, Supabase-style: `not(field, op, value)`. Supported where the
   * server has a direct inverse — `not(f,'eq',v)`→neq, `not(f,'in',[…])`→nin,
   * `not(f,'is',null)`→is_not_null. Other operators throw.
   */
  not(field: string, operator: OperatorAlias | 'is', value?: unknown): this {
    if (operator === 'eq' || operator === '=' || operator === '==') return this.neq(field, value);
    if (operator === 'in') return this.nin(field, (value as unknown[]) ?? []);
    if (operator === 'is') {
      if (value !== null) throw new QueryBuilderError("not(field, 'is', …) only supports null");
      return this.isNotNull(field);
    }
    throw new QueryBuilderError(`not() does not support operator: ${String(operator)}`);
  }

  /** Applies several equality filters from an object (Supabase `match`). */
  match(conditions: Record<string, unknown>): this {
    for (const [field, value] of Object.entries(conditions)) this.eq(field, value);
    return this;
  }

  /** Sets the free-text search term (matched across text-like columns). */
  search(term: string): this {
    this.searchTerm = term;
    return this;
  }

  /** Adds a sort key. Call multiple times for tie-breakers. */
  sort(field: string, direction: SortDirection = 'asc'): this {
    this.sorts.push({ field, direction });
    return this;
  }

  /**
   * Adds a sort key, Supabase-style: `order('created_at', { ascending: false })`.
   * Also accepts a direction string. Defaults to ascending.
   */
  order(field: string, options?: { ascending?: boolean } | SortDirection): this {
    const direction: SortDirection =
      typeof options === 'string' ? options : options?.ascending === false ? 'desc' : 'asc';
    return this.sort(field, direction);
  }

  /** Sets the 1-based page number. */
  page(page: number): this {
    this.pageNum = page;
    return this;
  }

  /** Sets the page size (server clamps to its maximum). */
  pageSize(size: number): this {
    this.pageSizeNum = size;
    return this;
  }

  /**
   * Offset-based paging: cap the number of rows (Supabase/PostgREST `limit`).
   * Takes precedence over `pageSize` on the server.
   */
  limit(count: number): this {
    this.limitNum = count;
    return this;
  }

  /** Offset-based paging: skip this many rows. Takes precedence over `page`. */
  offset(count: number): this {
    this.offsetNum = count;
    return this;
  }

  /**
   * Inclusive row range (Supabase `range`): `range(0, 24)` returns the first 25
   * rows. Sets `offset = from` and `limit = to - from + 1`.
   */
  range(from: number, to: number): this {
    this.offsetNum = from;
    this.limitNum = Math.max(1, to - from + 1);
    return this;
  }

  /** Requests expansion of the named relationships. */
  expand(...relationships: string[]): this {
    this.expands.push(...relationships);
    return this;
  }

  /**
   * Restricts the returned fields (projection). Accepts a comma-separated string
   * (`select('id, name')`) or separate field names (`select('id', 'name')`).
   */
  select(...fields: string[]): this {
    for (const f of fields) {
      for (const part of f.split(',')) {
        const trimmed = part.trim();
        if (trimmed) this.selects.push(trimmed);
      }
    }
    return this;
  }

  /** Builds a `URLSearchParams` for the accumulated query. */
  toSearchParams(): URLSearchParams {
    const params = new URLSearchParams();

    for (const f of this.filters) {
      const key = f.operator === 'eq' ? f.field : `${f.field}[${f.operator}]`;
      params.append(key, f.value);
    }
    if (this.searchTerm !== undefined) params.set('search', this.searchTerm);
    if (this.sorts.length > 0) {
      params.set(
        'sort',
        this.sorts.map((s) => (s.direction === 'desc' ? `-${s.field}` : s.field)).join(','),
      );
    }
    if (this.pageNum !== undefined) params.set('page', String(this.pageNum));
    if (this.pageSizeNum !== undefined) params.set('pageSize', String(this.pageSizeNum));
    if (this.limitNum !== undefined) params.set('limit', String(this.limitNum));
    if (this.offsetNum !== undefined) params.set('offset', String(this.offsetNum));
    if (this.expands.length > 0) params.set('expand', this.expands.join(','));
    if (this.selects.length > 0) params.set('select', this.selects.join(','));

    return params;
  }

  /** Builds the query string (without a leading `?`). */
  toQueryString(): string {
    return this.toSearchParams().toString();
  }

  toString(): string {
    return this.toQueryString();
  }
}

/** Convenience factory so callers can write `query().where(...)`. */
export function query(): QueryBuilder {
  return new QueryBuilder();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders a filter value for the URL. Dates become ISO strings; null/undefined
 * become empty. Everything else is stringified as-is (the server coerces
 * numbers and booleans back from their textual form).
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export class QueryBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryBuilderError';
  }
}
