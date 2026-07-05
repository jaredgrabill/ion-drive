/**
 * Public types for the Ion Drive client SDK.
 *
 * These mirror the wire shapes returned by the Ion Drive REST API (the
 * `{ data, pagination }` envelope and friends). They are intentionally
 * re-declared here rather than imported from `@ionshift/ion-drive-core` so the client
 * stays a **zero-dependency** package that runs unchanged in the browser.
 */

/** A single data record. Callers may parameterise this with their own type. */
export type Record_ = Record<string, unknown>;

/**
 * Comparison operators accepted by the filter DSL. These match the canonical
 * operators understood by the server's query parser. The builder additionally
 * accepts aliases (see {@link OperatorAlias}) and normalises them.
 */
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

/** Human-friendly aliases the builder maps onto canonical operators. */
export type OperatorAlias =
  | FilterOperator
  | 'ne'
  | '='
  | '=='
  | '!='
  | '<>'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'contains'
  | 'notin';

export type SortDirection = 'asc' | 'desc';

/** Pagination metadata returned alongside every list response. */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** Envelope returned by a list query. */
export interface QueryResult<T = Record_> {
  data: T[];
  pagination: PaginationMeta;
}

/** Envelope returned by single-record reads and writes. */
export interface SingleResult<T = Record_> {
  data: T;
}

/** Result of a bulk create/delete. */
export interface BulkResult {
  count: number;
  ids: string[];
}

/** Options for constructing an {@link IonDriveClient}. */
export interface IonDriveClientOptions {
  /** Base URL of the Ion Drive server, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Optional API key (`iond_…`). Sent as the `X-API-Key` header. */
  apiKey?: string;
  /**
   * Optional `fetch` implementation. Defaults to the global `fetch`
   * (available in Node 18+ and all modern browsers). Provide one to inject a
   * mock in tests or a custom agent.
   */
  fetch?: typeof fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}
