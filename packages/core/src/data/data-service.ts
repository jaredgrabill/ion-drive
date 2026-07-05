/**
 * Data Service — Generic CRUD operations for any runtime-defined data object.
 *
 * This service builds and executes Kysely queries against tenant data tables.
 * It uses the Schema Registry to know which tables/columns exist and
 * validates input against field definitions.
 *
 * All operations accept the data object name (e.g., "contacts") and
 * translate that into the physical table name via the Schema Registry.
 */

import type { Kysely } from 'kysely';
import type { TenantDatabase } from '../db/types.js';
import { computeDiff } from '../messaging/diff.js';
import type {
  BusTransaction,
  CrudEventPayload,
  CrudOperation,
  FieldDiff,
} from '../messaging/event-types.js';
import type { MessageBus } from '../messaging/message-bus.js';
import { NoopBus } from '../messaging/noop-bus.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { COLUMN_TYPES } from '../schema/types.js';
import type {
  BulkResult,
  FilterCondition,
  PaginationMeta,
  QueryOptions,
  QueryResult,
  SingleResult,
} from './types.js';

/** Column-type categories whose values are worth matching in a free-text search. */
const SEARCHABLE_CATEGORIES = new Set(['text', 'enum']);

export class DataService {
  /** Whether change events are emitted (false when wired with the {@link NoopBus}). */
  private readonly eventsEnabled: boolean;

  constructor(
    private readonly db: Kysely<TenantDatabase>,
    private readonly registry: SchemaRegistry,
    private readonly bus: MessageBus = new NoopBus(),
  ) {
    this.eventsEnabled = !(bus instanceof NoopBus);
  }

  // =========================================================================
  // Read Operations
  // =========================================================================

  /**
   * Lists records for a data object with filtering, sorting, and pagination.
   */
  async list(objectName: string, options: QueryOptions = {}): Promise<QueryResult> {
    const tableName = this.resolveTable(objectName);
    const objDef = this.registry.getObject(objectName);
    if (!objDef) throw new Error(`Unknown object: ${objectName}`);

    // Validate filter/sort fields up front (throws DataServiceError on unknown fields).
    for (const filter of options.filters ?? []) this.validateField(objectName, filter.field);
    for (const sort of options.sort ?? []) this.validateField(objectName, sort.field);

    // Build base query, applying filters + free-text search identically to the
    // count query so pagination totals stay consistent with the returned rows.
    let query = this.applyConditions(
      this.db.selectFrom(tableName).selectAll(),
      objectName,
      options,
    );

    // Apply sort
    if (options.sort?.length) {
      for (const sort of options.sort) {
        query = query.orderBy(sort.field, sort.direction) as typeof query;
      }
    } else {
      // Default sort by created_at desc
      query = query.orderBy('created_at', 'desc') as typeof query;
    }

    // Get total count (before pagination) under the same filter + search conditions.
    const filteredCountQuery = this.applyConditions(
      this.db.selectFrom(tableName).select(this.db.fn.countAll().as('count')),
      objectName,
      options,
    );

    const countResult = await filteredCountQuery.executeTakeFirst();
    const totalCount = Number(countResult?.count ?? 0);

    // Resolve the window. Offset-based params (limit/offset) take precedence
    // over the page-based interface (page/pageSize); the reported page/pageSize
    // are derived from whichever was used so the metadata is always coherent.
    const { limit, offset, page, pageSize } = this.resolveWindow(options.pagination);

    query = query.limit(limit).offset(offset) as typeof query;

    // Execute
    const rows = await query.execute();

    // Build pagination metadata
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const pagination: PaginationMeta = {
      page,
      pageSize,
      totalCount,
      totalPages,
      hasNextPage: offset + rows.length < totalCount,
      hasPreviousPage: offset > 0,
    };

    return { data: rows as Record<string, unknown>[], pagination };
  }

  /**
   * Gets a single record by ID.
   */
  async getById(objectName: string, id: string): Promise<SingleResult | null> {
    const tableName = this.resolveTable(objectName);

    const row = await this.db
      .selectFrom(tableName)
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return null;
    return { data: row as Record<string, unknown> };
  }

  // =========================================================================
  // Write Operations
  // =========================================================================

  /**
   * Creates a new record. The insert and its `data.<object>.created` event are
   * written in one transaction (transactional outbox), so an event is never
   * emitted for a write that rolled back and vice versa.
   */
  async create(objectName: string, data: Record<string, unknown>): Promise<SingleResult> {
    const tableName = this.resolveTable(objectName);
    const cleanData = this.sanitizeInput(objectName, data);

    const row = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto(tableName)
        .values(cleanData)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (this.eventsEnabled) {
        await this.emit(trx, objectName, 'created', {
          id: String(inserted.id),
          before: null,
          after: inserted as Record<string, unknown>,
        });
      }
      return inserted;
    });

    this.wake();
    return { data: row as Record<string, unknown> };
  }

  /**
   * Updates an existing record by ID. When events are enabled the prior row is
   * read in the same transaction to compute a system-field-free diff carried on
   * the `data.<object>.updated` event.
   */
  async update(
    objectName: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<SingleResult | null> {
    const tableName = this.resolveTable(objectName);
    const cleanData = this.sanitizeInput(objectName, data);

    const row = await this.db.transaction().execute(async (trx) => {
      const before = this.eventsEnabled
        ? await trx.selectFrom(tableName).selectAll().where('id', '=', id).executeTakeFirst()
        : undefined;

      const after = await trx
        .updateTable(tableName)
        .set(cleanData)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!after) return null;

      if (this.eventsEnabled) {
        const beforeRow = (before ?? null) as Record<string, unknown> | null;
        const afterRow = after as Record<string, unknown>;
        const diff: FieldDiff | null = beforeRow ? computeDiff(beforeRow, afterRow) : null;
        await this.emit(trx, objectName, 'updated', {
          id: String(after.id),
          before: beforeRow,
          after: afterRow,
          diff,
        });
      }
      return after;
    });

    if (!row) return null;
    this.wake();
    return { data: row as Record<string, unknown> };
  }

  /**
   * Deletes a record by ID. Uses `DELETE … RETURNING` so the removed row can
   * ride the `data.<object>.deleted` event as its before-image.
   */
  async delete(objectName: string, id: string): Promise<boolean> {
    const tableName = this.resolveTable(objectName);

    const deleted = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom(tableName)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      if (this.eventsEnabled) {
        await this.emit(trx, objectName, 'deleted', {
          id: String(row.id),
          before: row as Record<string, unknown>,
          after: null,
        });
      }
      return row;
    });

    if (!deleted) return false;
    this.wake();
    return true;
  }

  // =========================================================================
  // Bulk Operations
  // =========================================================================

  /**
   * Creates multiple records in a single operation, emitting one
   * `data.<object>.created` event per inserted row (all in one transaction).
   */
  async bulkCreate(objectName: string, records: Record<string, unknown>[]): Promise<BulkResult> {
    const tableName = this.resolveTable(objectName);
    if (records.length === 0) return { count: 0, ids: [] };
    const cleanRecords = records.map((r) => this.sanitizeInput(objectName, r));

    const rows = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto(tableName)
        .values(cleanRecords)
        .returningAll()
        .execute();
      if (this.eventsEnabled) {
        for (const row of inserted) {
          await this.emit(trx, objectName, 'created', {
            id: String((row as Record<string, unknown>).id),
            before: null,
            after: row as Record<string, unknown>,
          });
        }
      }
      return inserted;
    });

    this.wake();
    return {
      count: rows.length,
      ids: rows.map((r) => String((r as Record<string, unknown>).id)),
    };
  }

  /**
   * Deletes multiple records by IDs. Uses `DELETE … RETURNING` so each removed
   * row can carry its own `data.<object>.deleted` event and the reported ids are
   * the rows actually deleted.
   */
  async bulkDelete(objectName: string, ids: string[]): Promise<BulkResult> {
    const tableName = this.resolveTable(objectName);
    if (ids.length === 0) return { count: 0, ids: [] };

    const rows = await this.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom(tableName)
        .where('id', 'in', ids)
        .returningAll()
        .execute();
      if (this.eventsEnabled) {
        for (const row of deleted) {
          await this.emit(trx, objectName, 'deleted', {
            id: String((row as Record<string, unknown>).id),
            before: row as Record<string, unknown>,
            after: null,
          });
        }
      }
      return deleted;
    });

    this.wake();
    return {
      count: rows.length,
      ids: rows.map((r) => String((r as Record<string, unknown>).id)),
    };
  }

  /**
   * Inserts a row **without** emitting a change event. Used by event consumers
   * (e.g. the audit block's `persist_event` handler) that write into a data
   * object in reaction to an event — emitting here would recurse.
   */
  async insertSilent(objectName: string, data: Record<string, unknown>): Promise<void> {
    const tableName = this.resolveTable(objectName);
    const cleanData = this.sanitizeInput(objectName, data);
    await this.db.insertInto(tableName).values(cleanData).execute();
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /**
   * Publishes a `data.<object>.<op>` change event within the caller's
   * transaction (transactional outbox). No-op paths are avoided by the
   * `eventsEnabled` guards at each call site.
   */
  private async emit(
    trx: BusTransaction,
    objectName: string,
    op: CrudOperation,
    images: {
      id: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      diff?: FieldDiff | null;
    },
  ): Promise<void> {
    const payload: CrudEventPayload = {
      object: objectName,
      id: images.id,
      op,
      before: images.before,
      after: images.after,
      diff: images.diff ?? null,
    };
    await this.bus.publish({ topic: `data.${objectName}.${op}`, payload }, trx);
  }

  /** Nudges the dispatcher to drain immediately once a write has committed. */
  private wake(): void {
    if (this.eventsEnabled) this.bus.wake();
  }

  /**
   * Resolves an object name to its physical table name.
   */
  private resolveTable(objectName: string): string {
    const tableName = this.registry.getTableName(objectName);
    if (!tableName) {
      throw new DataServiceError(`Data object "${objectName}" not found`, 'OBJECT_NOT_FOUND', 404);
    }
    return tableName;
  }

  /**
   * Validates that a field exists on the object.
   */
  private validateField(objectName: string, fieldName: string): void {
    const field = this.registry.getField(objectName, fieldName);
    // Allow querying by column_name or field name
    if (!field) {
      const fields = this.registry.getFields(objectName);
      const byColumn = fields.find((f) => f.columnName === fieldName);
      if (!byColumn) {
        throw new DataServiceError(
          `Unknown field "${fieldName}" on object "${objectName}"`,
          'UNKNOWN_FIELD',
          400,
        );
      }
    }
  }

  /**
   * Sanitizes input data by filtering to only known, writable columns.
   * Strips system fields (id, created_at, updated_at) from input.
   */
  private sanitizeInput(
    objectName: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const fields = this.registry.getFields(objectName);
    const writableFields = fields.filter((f) => !f.isSystem && !f.isPrimary);

    const fieldMap = new Map(writableFields.map((f) => [f.name, f]));
    const columnMap = new Map(writableFields.map((f) => [f.columnName, f]));

    const clean: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      // Match by field name first, then column name
      const field = fieldMap.get(key) ?? columnMap.get(key);
      if (field) {
        clean[field.columnName] = value;
      }
    }

    return clean;
  }

  /**
   * Resolves the effective query window from the pagination options. When
   * `limit`/`offset` are supplied they win and the page/pageSize returned in the
   * metadata are derived from them; otherwise the page-based interface is used.
   */
  private resolveWindow(pagination?: {
    page?: number;
    pageSize?: number;
    limit?: number;
    offset?: number;
  }): { limit: number; offset: number; page: number; pageSize: number } {
    const page = Math.max(1, pagination?.page ?? 1);
    const pageSize = Math.max(1, pagination?.pageSize ?? 25);

    if (pagination?.limit !== undefined || pagination?.offset !== undefined) {
      const limit = Math.max(1, pagination.limit ?? pageSize);
      const offset = Math.max(0, pagination.offset ?? 0);
      // Report the page this offset falls on (1-based) for coherent metadata.
      return { limit, offset, page: Math.floor(offset / limit) + 1, pageSize: limit };
    }

    return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
  }

  /**
   * Applies the WHERE clause shared by the list query and its count query:
   * every filter condition (AND-ed) plus an optional free-text search (an OR
   * of ILIKE matches across the object's text-like columns).
   */
  // biome-ignore lint/suspicious/noExplicitAny: Kysely query types are dynamic
  private applyConditions(query: any, objectName: string, options: QueryOptions): any {
    let q = query;

    for (const filter of options.filters ?? []) {
      q = this.applyFilter(q, filter);
    }

    const search = options.search?.trim();
    if (search) {
      const columns = this.searchableColumns(objectName);
      if (columns.length > 0) {
        const pattern = `%${escapeLikePattern(search)}%`;
        // biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder is dynamic here
        q = q.where((eb: any) => eb.or(columns.map((col) => eb(col, 'ilike', pattern))));
      }
    }

    return q;
  }

  /**
   * Returns the physical column names eligible for free-text search: the
   * object's non-system text-like columns (text and enum categories).
   */
  private searchableColumns(objectName: string): string[] {
    return this.registry
      .getFields(objectName)
      .filter((f) => !f.isSystem && SEARCHABLE_CATEGORIES.has(COLUMN_TYPES[f.columnType]?.category))
      .map((f) => f.columnName);
  }

  /**
   * Applies a filter condition to a Kysely query.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Kysely query types are dynamic
  private applyFilter(query: any, filter: FilterCondition): any {
    const { field, operator, value } = filter;

    switch (operator) {
      case 'eq':
        return query.where(field, '=', value);
      case 'neq':
        return query.where(field, '!=', value);
      case 'gt':
        return query.where(field, '>', value);
      case 'gte':
        return query.where(field, '>=', value);
      case 'lt':
        return query.where(field, '<', value);
      case 'lte':
        return query.where(field, '<=', value);
      case 'like':
        return query.where(field, 'like', `%${value}%`);
      case 'ilike':
        return query.where(field, 'ilike', `%${value}%`);
      case 'in':
        return query.where(field, 'in', value as unknown[]);
      case 'nin':
        return query.where(field, 'not in', value as unknown[]);
      case 'is_null':
        return query.where(field, 'is', null);
      case 'is_not_null':
        return query.where(field, 'is not', null);
      default:
        return query;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escapes the LIKE/ILIKE wildcard metacharacters (`%`, `_`) and the escape
 * character itself so a user's search term is matched literally rather than
 * being interpreted as a pattern. PostgreSQL's default LIKE escape is `\`.
 */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Custom Error
// ---------------------------------------------------------------------------

export class DataServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'DataServiceError';
  }
}
