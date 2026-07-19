/**
 * Query types for the data access layer.
 *
 * These types define how API consumers can filter, sort, paginate,
 * and expand relationships when querying data objects.
 */

// ---------------------------------------------------------------------------
// Query Parameters
// ---------------------------------------------------------------------------

export interface QueryOptions {
  /** Filter conditions */
  filters?: FilterCondition[];
  /**
   * Free-text search term. When set, matches records whose text-like columns
   * contain the term (case-insensitive OR across all text/enum fields). This is
   * the `?search=`/`?q=` query parameter on the REST surface and the `search`
   * argument on GraphQL/MCP.
   */
  search?: string;
  /** Sort order */
  sort?: SortOption[];
  /** Pagination */
  pagination?: PaginationOptions;
  /** Relationship fields to expand (include related records) */
  expand?: string[];
  /** Specific fields to select (empty = all) */
  select?: string[];
}

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'nin'
  | 'is_null'
  | 'is_not_null';

export interface SortOption {
  field: string;
  direction: 'asc' | 'desc';
}

export interface PaginationOptions {
  page: number;
  pageSize: number;
  /**
   * Offset-based pagination (Supabase/PostgREST-style). When `limit` or
   * `offset` is set they take precedence over `page`/`pageSize`: the window
   * becomes rows `[offset, offset + limit)`. `page`/`pageSize` remain the
   * default, page-based interface.
   */
  offset?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Aggregates (leaderboard-shaped reads — issue #13)
// ---------------------------------------------------------------------------

/**
 * The supported aggregate functions. Deliberately minimal: no group-by, no
 * window functions — rank/percentile derive from filtered counts (see
 * docs/api/querying.md "Leaderboards & aggregates").
 */
export const AGGREGATE_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;

export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];

/**
 * Options accepted by an aggregate query — the same filter + search subset of
 * {@link QueryOptions} the list endpoint takes (sort/pagination/expand/select
 * do not apply to a single scalar result).
 */
export interface AggregateOptions {
  filters?: FilterCondition[];
  search?: string;
}

export interface AggregateResult {
  fn: AggregateFunction;
  /** The aggregated field (API name), or null for a bare `count`. */
  field: string | null;
  /**
   * The aggregate value. `null` when no rows matched (SQL semantics for
   * sum/avg/min/max over an empty set). Values are coerced to JSON numbers;
   * NUMERIC/BIGINT results beyond 2^53 lose precision.
   */
  value: number | null;
  /** Rows matching the filters + search — same number the list endpoint reports as `pagination.totalCount`. */
  filteredCount: number;
}

// ---------------------------------------------------------------------------
// Query Results
// ---------------------------------------------------------------------------

export interface QueryResult<T = Record<string, unknown>> {
  data: T[];
  pagination: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface SingleResult<T = Record<string, unknown>> {
  data: T;
}

/**
 * Envelope returned by an upsert (issue #9): the row plus whether the
 * statement inserted it (`true`) or updated an existing one (`false`).
 */
export interface UpsertResult<T = Record<string, unknown>> {
  data: T;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Mutation Inputs
// ---------------------------------------------------------------------------

export interface CreateInput {
  data: Record<string, unknown>;
}

export interface UpdateInput {
  data: Record<string, unknown>;
}

export interface BulkCreateInput {
  data: Record<string, unknown>[];
}

export interface BulkDeleteInput {
  ids: string[];
}

export interface BulkResult {
  count: number;
  ids: string[];
}
