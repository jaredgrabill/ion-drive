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
import { COLUMN_TYPES, type FieldConstraints } from '../schema/types.js';
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
      // Default sort: created_at desc when the object has it; adopted tables
      // (drift doctor) may not, so fall back to the primary key.
      const fallback = objDef.fields.some((f) => f.columnName === 'created_at')
        ? 'created_at'
        : objDef.fields.find((f) => f.isPrimary)?.columnName;
      if (fallback) query = query.orderBy(fallback, 'desc') as typeof query;
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
    const rows = (await query.execute()) as Record<string, unknown>[];

    // Attach related records for requested expansions (Phase 10 / Tier 3B).
    if (options.expand?.length) {
      await this.applyExpansions(objectName, rows, options.expand);
    }

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
   * Gets a single record by ID. `expand` attaches related records under their
   * relationship names, like the list endpoint.
   */
  async getById(
    objectName: string,
    id: string,
    options: { expand?: string[] } = {},
  ): Promise<SingleResult | null> {
    const tableName = this.resolveTable(objectName);

    const row = await this.db
      .selectFrom(tableName)
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return null;
    const record = row as Record<string, unknown>;
    if (options.expand?.length) {
      await this.applyExpansions(objectName, [record], options.expand);
    }
    return { data: record };
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
    this.validateConstraints(objectName, cleanData);

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
    this.validateConstraints(objectName, cleanData);

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
    for (const record of cleanRecords) this.validateConstraints(objectName, record);

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
   * Attaches related records to rows for each requested relationship name
   * (Phase 10 / Tier 3B — powers linked-record chips and peeks).
   *
   * Supported shapes:
   * - FK on **this** object (many_to_one/one_to_one from here, or one_to_many
   *   *to* here): one batched `WHERE id IN (…)` fetch of the other side, each
   *   row gains `row[relName] = relatedRecord | null`.
   * - many_to_many: one junction-table fetch + one target fetch, each row
   *   gains `row[relName] = relatedRecord[]`.
   *
   * Unknown expansion names are ignored (lenient, like unknown select fields).
   */
  private async applyExpansions(
    objectName: string,
    rows: Record<string, unknown>[],
    expand: string[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const obj = this.registry.getObject(objectName);
    if (!obj) return;

    for (const relName of expand) {
      const rel = (obj.relationships ?? []).find((r) => r.name === relName);
      if (!rel) continue;

      if (rel.type === 'many_to_many') {
        await this.expandManyToMany(objectName, rows, rel);
        continue;
      }

      // The FK lives on this object when it points outward (many_to_one /
      // one_to_one from here) or when a one_to_many names it as the target.
      const fkOnThisObject =
        rel.type === 'one_to_many'
          ? rel.targetObjectName === objectName
          : rel.sourceObjectName === objectName;
      if (!fkOnThisObject) continue;

      const otherObject = rel.type === 'one_to_many' ? rel.sourceObjectName : rel.targetObjectName;
      const otherTable = this.registry.getTableName(otherObject);
      if (!otherTable) continue;

      const fkColumn = `${rel.name}_id`;
      const ids = [...new Set(rows.map((r) => r[fkColumn]).filter((v) => v != null))];
      if (ids.length === 0) {
        for (const row of rows) row[rel.name] = null;
        continue;
      }
      const related = await this.db
        .selectFrom(otherTable)
        .selectAll()
        .where('id', 'in', ids)
        .execute();
      const byId = new Map((related as Record<string, unknown>[]).map((r) => [String(r.id), r]));
      for (const row of rows) {
        const fk = row[fkColumn];
        row[rel.name] = fk == null ? null : (byId.get(String(fk)) ?? null);
      }
    }
  }

  /** Expands a many_to_many relationship via its junction table. */
  private async expandManyToMany(
    objectName: string,
    rows: Record<string, unknown>[],
    rel: NonNullable<NonNullable<ReturnType<SchemaRegistry['getObject']>>['relationships']>[number],
  ): Promise<void> {
    const isSource = rel.sourceObjectName === objectName;
    const otherObject = isSource ? rel.targetObjectName : rel.sourceObjectName;
    const thisTable = this.registry.getTableName(objectName);
    const otherTable = this.registry.getTableName(otherObject);
    if (!thisTable || !otherTable) return;

    // Junction info is recorded since Phase 10; fall back to the naming
    // convention for relationships created before that.
    const sourceTable = this.registry.getTableName(rel.sourceObjectName) ?? '';
    const targetTable = this.registry.getTableName(rel.targetObjectName) ?? '';
    const junction = rel.junctionTable ?? `${sourceTable}_${targetTable}`;
    const sourceCol = rel.junctionSourceColumn ?? `${sourceTable}_id`;
    const targetCol = rel.junctionTargetColumn ?? `${targetTable}_id`;
    const thisCol = isSource ? sourceCol : targetCol;
    const otherCol = isSource ? targetCol : sourceCol;

    const ids = rows.map((r) => r.id).filter((v) => v != null);
    const links = (await this.db
      .selectFrom(junction)
      .select([thisCol, otherCol])
      .where(thisCol, 'in', ids)
      .execute()) as Record<string, unknown>[];

    const otherIds = [...new Set(links.map((l) => l[otherCol]).filter((v) => v != null))];
    const related =
      otherIds.length === 0
        ? []
        : ((await this.db
            .selectFrom(otherTable)
            .selectAll()
            .where('id', 'in', otherIds)
            .execute()) as Record<string, unknown>[]);
    const byId = new Map(related.map((r) => [String(r.id), r]));

    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const link of links) {
      const key = String(link[thisCol]);
      const other = byId.get(String(link[otherCol]));
      if (!other) continue;
      const list = grouped.get(key) ?? [];
      list.push(other);
      grouped.set(key, list);
    }
    for (const row of rows) {
      row[rel.name] = grouped.get(String(row.id)) ?? [];
    }
  }

  /**
   * Validates written values against their field constraints (Phase 10 / 1B).
   *
   * The real enforcement is the generated CHECK constraints in Postgres; this
   * pre-check exists so API callers get a friendly 400 naming the field and
   * rule (or the constraint's custom `message`) instead of a raw PG check
   * violation. NULL/undefined values pass — matching CHECK semantics, where
   * required-ness is NOT NULL's job.
   */
  private validateConstraints(objectName: string, cleanData: Record<string, unknown>): void {
    const fields = this.registry.getFields(objectName);
    for (const field of fields) {
      const constraints = field.constraints;
      if (!constraints) continue;
      const value = cleanData[field.columnName];
      if (value === undefined || value === null) continue;

      const problem = constraintViolation(value, field.columnType, constraints);
      if (problem) {
        throw new DataServiceError(
          constraints.message ?? `Field "${field.name}" ${problem}`,
          'CONSTRAINT_VIOLATION',
          400,
        );
      }
    }
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

/** Numeric column types where min/max bound the value (not the length). */
const NUMERIC_CATEGORIES = new Set(['number']);

/**
 * Checks one value against a field's constraints. Returns a human-readable
 * description of the violated rule, or null when the value passes. Mirrors the
 * CHECK constraint semantics of `schema/check-constraints.ts`.
 */
function constraintViolation(
  value: unknown,
  columnType: string,
  constraints: FieldConstraints,
): string | null {
  const category = COLUMN_TYPES[columnType as keyof typeof COLUMN_TYPES]?.category;
  const isNumeric = NUMERIC_CATEGORIES.has(category) || columnType === 'rating';

  if (isNumeric && typeof value === 'number') {
    if (constraints.min !== undefined && value < constraints.min) {
      return `must be at least ${constraints.min}`;
    }
    if (constraints.max !== undefined && value > constraints.max) {
      return `must be at most ${constraints.max}`;
    }
  }

  if (typeof value === 'string') {
    if (constraints.min !== undefined && !isNumeric && value.length < constraints.min) {
      return `must be at least ${constraints.min} characters`;
    }
    if (constraints.max !== undefined && !isNumeric && value.length > constraints.max) {
      return `must be at most ${constraints.max} characters`;
    }
    if (constraints.pattern) {
      try {
        if (!new RegExp(constraints.pattern).test(value)) {
          return `must match the pattern ${constraints.pattern}`;
        }
      } catch {
        // Invalid JS regex (POSIX-only syntax) — let Postgres be the judge.
      }
    }
    if (constraints.enumValues?.length && columnType !== 'multi_enum') {
      if (!constraints.enumValues.includes(value)) {
        return `must be one of: ${constraints.enumValues.join(', ')}`;
      }
    }
  }

  if (columnType === 'multi_enum' && Array.isArray(value) && constraints.enumValues?.length) {
    const invalid = value.filter(
      (v) => typeof v === 'string' && !constraints.enumValues?.includes(v),
    );
    if (invalid.length > 0) {
      return `contains invalid value(s): ${invalid.join(', ')} (allowed: ${constraints.enumValues.join(', ')})`;
    }
  }

  return null;
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
