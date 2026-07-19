/**
 * IonDriveClient — a small, typed fetch wrapper over the Ion Drive REST API.
 *
 * The read API is fluent and awaitable, inspired by Supabase's postgrest-js: you
 * start from a resource, chain filters/modifiers, and `await` the chain — no
 * terminal call needed.
 *
 *   const ion = new IonDriveClient({ baseUrl: 'http://localhost:3000', apiKey });
 *
 *   // READ — thenable builder (await executes it):
 *   const { data, pagination } = await ion
 *     .from('contacts')
 *     .select('id, full_name, email')
 *     .eq('status', 'active')
 *     .search('acme')
 *     .order('created_at', { ascending: false })
 *     .range(0, 24);
 *
 *   const one  = await ion.from('contacts').select().eq('id', id).single();     // throws if != 1
 *   const some = await ion.from('contacts').select().eq('email', e).maybeSingle(); // T | null
 *
 *   // WRITE — by id / bulk (mirrors the REST surface):
 *   const created = await ion.from('contacts').insert({ full_name: 'Ada' });
 *   await ion.from('contacts').update(id, { status: 'archived' });
 *   await ion.from('contacts').delete(id);
 *
 *   // ATOMIC COUNTERS + UPSERT (issue #9):
 *   await ion.from('player_stats').update(id, { wins: { $inc: 1 } });   // SET wins = wins + 1
 *   await ion.from('player_stats').increment(id, { wins: 1 });          // same, sugared
 *   const { data, created: isNew } = await ion
 *     .from('devices')
 *     .upsert({ device_id: 'abc' }, { onConflict: 'device_id' });       // INSERT … ON CONFLICT
 *
 *   // LINKS — many_to_many junction writes (Phase 13):
 *   await ion.from('contacts').link(id, 'tags', [tagId]);
 *   await ion.from('contacts').unlink(id, 'tags', [tagId]);
 *
 * Errors reject with a typed {@link IonDriveError}. Zero runtime dependencies —
 * it uses the global `fetch`.
 */

import { EventsApi } from './events.js';
import { QueryBuilder } from './query-builder.js';
import type {
  AggregateFunction,
  AggregateResult,
  BulkResult,
  IonDriveClientOptions,
  QueryResult,
  Record_,
  SingleResult,
  UpdateValues,
  UpsertOptions,
  UpsertResult,
} from './types.js';

export class IonDriveClient {
  /** Realtime event streaming over SSE (Phase 12): `ion.events.stream(...)`. */
  readonly events: EventsApi;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: IonDriveClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    const f = options.fetch ?? globalThis.fetch;
    if (!f) {
      throw new IonDriveError(
        'No fetch implementation available. Pass `fetch` in the client options.',
        0,
      );
    }
    this.fetchImpl = f.bind(globalThis);
    this.events = new EventsApi({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      headers: () => ({
        ...this.extraHeaders,
        ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      }),
    });
  }

  /** Returns a typed accessor for one data object (e.g. `contacts`). */
  from<T extends Record_ = Record_>(object: string): Resource<T> {
    return new Resource<T>(this, object);
  }

  /** Server health/version info. */
  async health(): Promise<{ status: string; version: string }> {
    return this.request('GET', '/health');
  }

  // --- Low-level request plumbing (used by Resource/ResourceQuery) -----------

  /** @internal */
  async request<T>(method: string, path: string, body?: unknown, query?: string): Promise<T> {
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.extraHeaders,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const parsed = text ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const message =
        (parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : undefined) ?? `Request failed with status ${res.status}`;
      throw new IonDriveError(message, res.status, parsed);
    }

    return parsed as T;
  }
}

/**
 * Resource — the entry point for one data object. `select()`/`query()` begin a
 * fluent read; the remaining methods are writes and by-id reads that mirror the
 * REST surface.
 */
export class Resource<T extends Record_ = Record_> {
  constructor(
    private readonly client: IonDriveClient,
    private readonly object: string,
  ) {}

  private get basePath(): string {
    return `/api/v1/data/${this.object}`;
  }

  /**
   * Begins a fluent, awaitable read. Optionally project fields
   * (`select('id, name')`). Chain filters/modifiers and `await` the result.
   */
  select(...columns: string[]): ResourceQuery<T> {
    const q = new ResourceQuery<T>(this.client, this.basePath);
    if (columns.length > 0) q.select(...columns);
    return q;
  }

  /** Alias of {@link select} with no projection — begins a read. */
  query(): ResourceQuery<T> {
    return new ResourceQuery<T>(this.client, this.basePath);
  }

  /** Fetches a single record by id, or `null` if not found. */
  async get(id: string): Promise<T | null> {
    try {
      const res = await this.client.request<SingleResult<T>>(
        'GET',
        `${this.basePath}/${encodeURIComponent(id)}`,
      );
      return res.data;
    } catch (err) {
      if (err instanceof IonDriveError && err.status === 404) return null;
      throw err;
    }
  }

  /** Inserts one record (returns it) or many (returns a bulk summary). */
  insert(record: Partial<T> | Record_): Promise<T>;
  insert(records: (Partial<T> | Record_)[]): Promise<BulkResult>;
  async insert(input: (Partial<T> | Record_) | (Partial<T> | Record_)[]): Promise<T | BulkResult> {
    if (Array.isArray(input)) {
      return this.client.request<BulkResult>('POST', `${this.basePath}/bulk`, { data: input });
    }
    const res = await this.client.request<SingleResult<T>>('POST', this.basePath, input);
    return res.data;
  }

  /** Alias of single-record {@link insert}. */
  create(record: Partial<T> | Record_): Promise<T> {
    return this.insert(record);
  }

  /**
   * Partially updates a record by id; returns `null` if not found. Numeric
   * fields accept atomic operators for concurrency-safe counters:
   *
   *   await ion.from('player_stats').update(id, { wins: { $inc: 1 } });
   */
  async update(id: string, data: UpdateValues<T>): Promise<T | null> {
    try {
      const res = await this.client.request<SingleResult<T>>(
        'PATCH',
        `${this.basePath}/${encodeURIComponent(id)}`,
        data,
      );
      return res.data;
    } catch (err) {
      if (err instanceof IonDriveError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Atomically adds to numeric fields (`SET field = field + n` in one
   * statement — safe under concurrent writers). Sugar over {@link update}
   * with `{ $inc }` operators; negative amounts subtract.
   *
   *   await ion.from('player_stats').increment(id, { wins: 1, shots_fired: 12 });
   */
  increment(id: string, fields: Record<string, number>): Promise<T | null> {
    const data: Record_ = {};
    for (const [field, amount] of Object.entries(fields)) data[field] = { $inc: amount };
    return this.update(id, data);
  }

  /**
   * Creates or updates a record in one atomic statement (PostgREST-style
   * upsert: `INSERT … ON CONFLICT DO UPDATE`). `onConflict` must name a
   * declared unique constraint — a single `isUnique` field, the primary key,
   * or a `uniqueTogether` group. Returns the row plus a `created` indicator.
   *
   *   const { data, created } = await ion
   *     .from('devices')
   *     .upsert({ device_id: 'abc', last_seen: now }, { onConflict: 'device_id' });
   */
  async upsert(record: Partial<T> | Record_, options: UpsertOptions): Promise<UpsertResult<T>> {
    const columns = Array.isArray(options.onConflict) ? options.onConflict : [options.onConflict];
    const query = `on_conflict=${encodeURIComponent(columns.join(','))}`;
    return this.client.request<UpsertResult<T>>('POST', this.basePath, record, query);
  }

  /** Deletes a record by id; returns `false` if it did not exist. */
  async delete(id: string): Promise<boolean> {
    try {
      await this.client.request<void>('DELETE', `${this.basePath}/${encodeURIComponent(id)}`);
      return true;
    } catch (err) {
      if (err instanceof IonDriveError && err.status === 404) return false;
      throw err;
    }
  }

  /** Deletes many records by id in one call. */
  async bulkDelete(ids: string[]): Promise<BulkResult> {
    return this.client.request<BulkResult>('DELETE', `${this.basePath}/bulk`, { ids });
  }

  /**
   * Adds many_to_many links between a record and target records (Phase 13).
   * Idempotent — already-linked ids are skipped; returns the number of links
   * actually added. FK-backed relationships are set via `update(id, {
   * <rel>_id })` instead.
   *
   *   await ion.from('contacts').link(contactId, 'tags', [tagA, tagB]);
   */
  async link(id: string, relationship: string, ids: string[]): Promise<{ added: number }> {
    const res = await this.client.request<{ data: { added: number } }>(
      'POST',
      this.linkPath(id, relationship),
      { ids },
    );
    return res.data;
  }

  /**
   * Removes many_to_many links between a record and target records (Phase
   * 13). Ids that were not linked are ignored; returns the number removed.
   */
  async unlink(id: string, relationship: string, ids: string[]): Promise<{ removed: number }> {
    const res = await this.client.request<{ data: { removed: number } }>(
      'DELETE',
      this.linkPath(id, relationship),
      { ids },
    );
    return res.data;
  }

  private linkPath(id: string, relationship: string): string {
    return `${this.basePath}/${encodeURIComponent(id)}/links/${encodeURIComponent(relationship)}`;
  }
}

/**
 * ResourceQuery — a {@link QueryBuilder} bound to a client + object. It is
 * **thenable**: `await`-ing it (or calling `.then`) executes the list request
 * and resolves to `{ data, pagination }`. Terminal helpers cover the common
 * single-row and array shapes.
 */
export class ResourceQuery<T extends Record_ = Record_>
  extends QueryBuilder
  implements PromiseLike<QueryResult<T>>
{
  constructor(
    private readonly client: IonDriveClient,
    private readonly basePath: string,
  ) {
    super();
  }

  /** Executes the query and returns the full `{ data, pagination }` envelope. */
  list(): Promise<QueryResult<T>> {
    return this.client.request<QueryResult<T>>(
      'GET',
      this.basePath,
      undefined,
      this.toQueryString(),
    );
  }

  /**
   * PromiseLike bridge — makes the builder awaitable. `await query` runs
   * {@link list} and yields the `QueryResult`. This is intentional (the
   * Supabase-style fluent-then-await ergonomic), hence the rule suppression.
   */
  // biome-ignore lint/suspicious/noThenProperty: intentional PromiseLike so `await query` executes the request
  then<TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.list().then(onfulfilled, onrejected);
  }

  /** Executes the query and returns just the rows. */
  async all(): Promise<T[]> {
    return (await this.list()).data;
  }

  /** Executes the query (limit 1) and returns the first row or `null`. Forgiving. */
  async first(): Promise<T | null> {
    const result = await this.limit(1).list();
    return result.data[0] ?? null;
  }

  /**
   * Expects exactly one matching row (Supabase `single`). Throws if zero or
   * more than one row matches.
   */
  async single(): Promise<T> {
    const result = await this.limit(2).list();
    if (result.data.length === 0 || result.pagination.totalCount === 0) {
      throw new IonDriveError('single(): expected exactly one row, got none', 404);
    }
    if (result.data.length > 1 || result.pagination.totalCount > 1) {
      throw new IonDriveError('single(): expected exactly one row, got multiple', 400);
    }
    return result.data[0] as T;
  }

  /**
   * Aggregate terminal (issue #13): computes one `count`/`sum`/`avg`/`min`/
   * `max` over the rows matching the chained filters + search. `count` needs
   * no field; the value fns require a numeric field. The result also carries
   * `filteredCount` (the matching-row count).
   *
   *   const { value } = await ion.from('players').query().aggregate('avg', 'damage_dealt');
   *   // Rank pattern — count the players ahead of you, add one:
   *   const rank = (await ion.from('players').query().gt('wins', mine).aggregate('count')).filteredCount + 1;
   */
  async aggregate(fn: AggregateFunction, field?: string): Promise<AggregateResult> {
    const params = this.toSearchParams();
    params.set('fn', fn);
    if (field !== undefined) params.set('field', field);
    const res = await this.client.request<{ data: AggregateResult }>(
      'GET',
      `${this.basePath}/aggregate`,
      undefined,
      params.toString(),
    );
    return res.data;
  }

  /** Counts the rows matching the chained filters + search (aggregate sugar). */
  async count(): Promise<number> {
    return (await this.aggregate('count')).filteredCount;
  }

  /**
   * Expects zero or one matching row (Supabase `maybeSingle`). Returns `null`
   * for none, the row for one, and throws when more than one matches.
   */
  async maybeSingle(): Promise<T | null> {
    const result = await this.limit(2).list();
    if (result.data.length > 1 || result.pagination.totalCount > 1) {
      throw new IonDriveError('maybeSingle(): expected at most one row, got multiple', 400);
    }
    return result.data[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class IonDriveError extends Error {
  constructor(
    message: string,
    /** HTTP status code (0 for client-side/transport errors). */
    public readonly status: number,
    /** Parsed error body, when the server returned one. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'IonDriveError';
  }
}
