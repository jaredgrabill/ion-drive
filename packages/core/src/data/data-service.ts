/**
 * Data Service — Generic CRUD operations for any runtime-defined data object.
 *
 * This service builds and executes Kysely queries against tenant data tables.
 * It uses the Schema Registry to know which tables/columns exist and
 * validates input against field definitions.
 *
 * All operations accept the data object name (e.g., "contacts") and
 * translate that into the physical table name via the Schema Registry.
 *
 * **Row-level policies (issue #7):** when a {@link RowPolicyEnforcer} is
 * wired (RBAC enforcement on), every operation resolves the ambient
 * principal's compiled policy for the (action, object) pair and applies it
 * here — the single shared service — so REST, GraphQL (including relation
 * traversal), and MCP inherit identical row scoping:
 *
 *   - reads (list/aggregate/getById) gain WHERE fragments in the same
 *     `applyConditions` pipeline as filters/search, so row counts, pages,
 *     and aggregates all agree;
 *   - relation hydration (`expand=`, GraphQL relation fields) applies the
 *     **target** object's read policy to each batched fetch;
 *   - update/delete/bulk/link writes guard their WHERE — a row the actor
 *     cannot see behaves exactly like a missing row (404);
 *   - create/bulk-create must produce a row the actor's create policy
 *     matches (owner columns are stamped, foreign values rejected);
 *   - upsert applies the create policy to the insert and the update policy
 *     to the conflict update (`DO UPDATE … WHERE`), so a conflict can never
 *     hijack a foreign row.
 *
 * `insertSilent` is exempt by design — it is the internal event-consumer
 * write path (audit block), never reachable from a request surface.
 */

import { type Kysely, sql } from 'kysely';
import {
  type CompiledRowCondition,
  type CompiledRowPolicy,
  ROW_POLICY_ALL,
  ROW_POLICY_DENIED,
  type RowPolicyEnforcer,
} from '../auth/rbac/row-policy.js';
import type { TenantDatabase } from '../db/types.js';
import { computeDiff } from '../messaging/diff.js';
import type {
  BusTransaction,
  CrudEventPayload,
  CrudOperation,
  FieldDiff,
  LinkEventPayload,
  LinkOperation,
} from '../messaging/event-types.js';
import type { MessageBus } from '../messaging/message-bus.js';
import { NoopBus } from '../messaging/noop-bus.js';
import { currentActor, currentActorId } from '../runtime/request-context.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import {
  COLUMN_TYPES,
  type FieldConstraints,
  type FieldDefinition,
  type RelationshipDefinition,
} from '../schema/types.js';
import { matchesUniqueTogether } from '../schema/unique-together.js';
import { splitAtomicOperations } from './atomic-ops.js';
import { DataServiceError, translatePgError } from './errors.js';
import { type RelationKey, findRelationKey, listRelationKeys } from './relation-keys.js';
import {
  AGGREGATE_FUNCTIONS,
  type AggregateFunction,
  type AggregateOptions,
  type AggregateResult,
  type BulkResult,
  type FilterCondition,
  type PaginationMeta,
  type QueryOptions,
  type QueryResult,
  type SingleResult,
  type UpsertResult,
} from './types.js';

/** Column-type categories whose values are worth matching in a free-text search. */
const SEARCHABLE_CATEGORIES = new Set(['text', 'enum']);

export class DataService {
  /** Whether change events are emitted (false when wired with the {@link NoopBus}). */
  private readonly eventsEnabled: boolean;

  /** Row-policy seam (issue #7). Absent = policies do not apply. */
  private rowPolicies?: RowPolicyEnforcer;

  constructor(
    private readonly db: Kysely<TenantDatabase>,
    private readonly registry: SchemaRegistry,
    private readonly bus: MessageBus = new NoopBus(),
  ) {
    this.eventsEnabled = !(bus instanceof NoopBus);
  }

  /**
   * Wires the row-policy enforcer (issue #7). Called from server assembly when
   * RBAC enforcement is on; without it every operation behaves exactly as
   * before (zero behavior change for policy-less deployments).
   */
  setRowPolicyEnforcer(enforcer: RowPolicyEnforcer | undefined): void {
    this.rowPolicies = enforcer;
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

    // Row policy (issue #7) — applied inside the same shared pipeline as
    // filters/search, so data rows, the count, and pagination all agree.
    const rowPolicy = await this.policyFor('read', objectName);

    // Build base query, applying filters + free-text search identically to the
    // count query so pagination totals stay consistent with the returned rows.
    let query = this.applyConditions(
      this.db.selectFrom(tableName).selectAll(),
      objectName,
      options,
      rowPolicy,
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
      rowPolicy,
    );

    const countResult = (await this.translated(filteredCountQuery.executeTakeFirst())) as
      | { count?: unknown }
      | undefined;
    const totalCount = Number(countResult?.count ?? 0);

    // Resolve the window. Offset-based params (limit/offset) take precedence
    // over the page-based interface (page/pageSize); the reported page/pageSize
    // are derived from whichever was used so the metadata is always coherent.
    const { limit, offset, page, pageSize } = this.resolveWindow(options.pagination);

    query = query.limit(limit).offset(offset) as typeof query;

    // Execute
    const rows = (await this.translated(query.execute())) as Record<string, unknown>[];

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
   * Computes a single aggregate (`count`/`sum`/`avg`/`min`/`max`) over the rows
   * matching the same filter + search conditions as {@link list} — one shared
   * `applyConditions` pipeline, so an aggregate always agrees with the list
   * endpoint's `pagination.totalCount` for the same query (issue #13).
   *
   * - `count` needs no field; with one it counts the field's non-null values.
   * - `sum`/`avg`/`min`/`max` require a numeric field (400 otherwise).
   * - One fn per call — a scalar in, a scalar out. Batching several fns was
   *   considered and skipped: it complicates every surface's response shape
   *   for a saving of one indexed query.
   *
   * The `filteredCount` in the result is always the matching-row count, so
   * `avg` callers get their denominator (and rank/percentile callers their
   * numerator) without a second request.
   */
  async aggregate(
    objectName: string,
    fn: string,
    field: string | undefined,
    options: AggregateOptions = {},
  ): Promise<AggregateResult> {
    const tableName = this.resolveTable(objectName);

    if (!(AGGREGATE_FUNCTIONS as readonly string[]).includes(fn)) {
      throw new DataServiceError(
        `Unknown aggregate function "${fn}" — expected one of: ${AGGREGATE_FUNCTIONS.join(', ')}`,
        'INVALID_AGGREGATE_FUNCTION',
        400,
      );
    }
    const aggregateFn = fn as AggregateFunction;

    for (const filter of options.filters ?? []) this.validateField(objectName, filter.field);

    // Resolve + validate the aggregated field. count works bare; the numeric
    // fns demand a numeric column (min/max over dates/text is deliberately out
    // of scope for the wedge — filtered sort+limit covers those reads).
    let fieldDef: FieldDefinition | undefined;
    if (field !== undefined) {
      fieldDef = this.resolveFieldDef(objectName, field);
    } else if (aggregateFn !== 'count') {
      throw new DataServiceError(
        `Aggregate function "${aggregateFn}" requires a "field" parameter naming a numeric field`,
        'AGGREGATE_FIELD_REQUIRED',
        400,
      );
    }
    if (fieldDef && aggregateFn !== 'count' && !isNumericColumn(fieldDef.columnType)) {
      throw new DataServiceError(
        `Field "${fieldDef.name}" on object "${objectName}" is not numeric (${fieldDef.columnType}) — "${aggregateFn}" requires a numeric field`,
        'AGGREGATE_FIELD_NOT_NUMERIC',
        400,
      );
    }

    const column = fieldDef?.columnName;
    // Row policy (issue #7): an aggregate that ignored row scoping would leak
    // hidden rows through totals — it shares the exact read pipeline instead.
    const rowPolicy = await this.policyFor('read', objectName);
    const query = this.applyConditions(
      this.db.selectFrom(tableName).select(
        // biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder is dynamic here
        (eb: any) => {
          const selections = [eb.fn.countAll().as('total')];
          if (column) selections.push(eb.fn[aggregateFn](column).as('value'));
          return selections;
        },
      ),
      objectName,
      options,
      rowPolicy,
    );

    const row = (await query.executeTakeFirst()) as { total: unknown; value?: unknown } | undefined;
    const filteredCount = Number(row?.total ?? 0);
    const value = column ? toNumericValue(row?.value) : filteredCount;

    return { fn: aggregateFn, field: fieldDef?.name ?? null, value, filteredCount };
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

    // Row policy (issue #7): a policy-hidden row answers like a missing one
    // (404), so get-by-id cannot be used to probe rows the list conceals.
    const rowPolicy = await this.policyFor('read', objectName);
    const row = await this.translated(
      this.applyRowPolicy(
        this.db.selectFrom(tableName).selectAll().where('id', '=', id),
        rowPolicy,
      ).executeTakeFirst(),
    );

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
    this.stampActor(objectName, cleanData, 'create');
    this.assertCreateAllowed(objectName, cleanData, await this.policyFor('create', objectName));

    const row = await this.translated(
      this.db.transaction().execute(async (trx) => {
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
      }),
    );

    this.wake();
    return { data: row as Record<string, unknown> };
  }

  /**
   * Creates or updates a record in one atomic statement (issue #9):
   * `INSERT … ON CONFLICT (<target>) DO UPDATE SET <non-conflict columns>`.
   * Race-free create-or-update — two concurrent reporters can never turn a
   * first-time insert into a unique-violation 500.
   *
   * The conflict target must be a *declared* unique constraint: a single
   * `isUnique` field, the primary key, or one of the object's
   * `constraints.uniqueTogether` groups (order-insensitive) — anything else
   * is a 400 naming the valid targets. Returns the row plus a `created`
   * indicator (`true` = inserted, `false` = updated an existing row, read
   * from Postgres' xmax system column so it is authoritative even under
   * races). Emits `data.<object>.created` or `.updated` accordingly.
   */
  async upsert(
    objectName: string,
    data: Record<string, unknown>,
    onConflict: string[],
  ): Promise<UpsertResult> {
    const tableName = this.resolveTable(objectName);
    // Keep the primary key: `on_conflict=id` is a legal target and needs the
    // supplied value to survive sanitization.
    const cleanData = this.sanitizeInput(objectName, data, { keepPrimary: true });
    const conflictColumns = this.resolveConflictTarget(objectName, onConflict);
    for (const column of conflictColumns) {
      if (cleanData[column] === undefined) {
        throw new DataServiceError(
          `Upsert body is missing a value for conflict column "${column}"`,
          'MISSING_CONFLICT_VALUE',
          400,
        );
      }
    }
    this.validateConstraints(objectName, cleanData);
    this.stampActor(objectName, cleanData, 'create');

    // Row policy (issue #7): the insert half must satisfy the create policy;
    // the conflict-update half counts as an update — its policy becomes the
    // DO UPDATE's WHERE, so an upsert can never hijack a foreign row.
    this.assertCreateAllowed(objectName, cleanData, await this.policyFor('create', objectName));
    const updatePolicy = await this.policyFor('update', objectName);

    // translated(): a constraint the upsert does NOT target (another unique
    // column, an FK, NOT NULL) can still fire — it maps to the platform error
    // contract (409/400, errors.ts) instead of a raw Postgres 500.
    const outcome = await this.translated(
      this.db.transaction().execute(async (trx) => {
        const before = this.eventsEnabled
          ? await this.readByColumns(trx, tableName, conflictColumns, cleanData)
          : undefined;

        const returned = await this.executeUpsertStatement(
          trx,
          tableName,
          cleanData,
          conflictColumns,
          updatePolicy,
        );
        const { _ion_created, ...record } = returned;
        const created = Boolean(_ion_created);

        if (this.eventsEnabled) {
          const beforeRow = (before ?? null) as Record<string, unknown> | null;
          await this.emit(trx, objectName, created ? 'created' : 'updated', {
            id: String(record.id),
            before: created ? null : beforeRow,
            after: record,
            diff: created || !beforeRow ? null : computeDiff(beforeRow, record),
          });
        }
        return { record, created };
      }),
    );

    this.wake();
    return { data: outcome.record, created: outcome.created };
  }

  /** Reads at most one row matching every given column's value (in-transaction). */
  private async readByColumns(
    trx: BusTransaction,
    tableName: string,
    columns: string[],
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    let query = trx.selectFrom(tableName).selectAll();
    for (const column of columns) {
      query = query.where(column, '=', values[column]) as typeof query;
    }
    return (await query.executeTakeFirst()) as Record<string, unknown> | undefined;
  }

  /**
   * Runs the single `INSERT … ON CONFLICT DO UPDATE … RETURNING` statement.
   * Everything except the conflict target, the id, and the create-only actor
   * stamp is overwritten on conflict; when the body carries nothing else, a
   * no-op self-assignment keeps DO UPDATE valid so RETURNING still yields the
   * existing row (PostgREST-style merge-duplicates). `_ion_created` rides
   * along as `(xmax = 0)` — true only for a freshly inserted row.
   *
   * A restricted update policy (issue #7) becomes the DO UPDATE's `WHERE`
   * (conditions qualified against the existing row): a conflict with a row the
   * actor may not update then returns nothing, which surfaces as a 403 —
   * the conflicting row exists but is out of the actor's reach.
   */
  private async executeUpsertStatement(
    trx: BusTransaction,
    tableName: string,
    cleanData: Record<string, unknown>,
    conflictColumns: string[],
    updatePolicy: CompiledRowPolicy,
  ): Promise<Record<string, unknown>> {
    const updateSet: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(cleanData)) {
      if (!conflictColumns.includes(column) && column !== 'created_by' && column !== 'id') {
        updateSet[column] = value;
      }
    }
    this.assertNoPolicyReassignment(updateSet, updatePolicy);
    const firstConflict = conflictColumns[0] as string;

    const returned = (await trx
      .insertInto(tableName)
      .values(cleanData)
      .onConflict((oc) => {
        const target = oc.columns(conflictColumns);
        const doUpdate =
          Object.keys(updateSet).length > 0
            ? target.doUpdateSet(updateSet)
            : target.doUpdateSet((eb) => ({
                [firstConflict]: eb.ref(`excluded.${firstConflict}`),
              }));
        // Qualify with the table name: inside DO UPDATE the bare name is the
        // existing row, but explicit is safer than implicit here.
        return this.applyRowPolicy(doUpdate, updatePolicy, tableName);
      })
      .returningAll()
      .returning(sql<boolean>`(xmax = 0)`.as('_ion_created'))
      .executeTakeFirst()) as Record<string, unknown> | undefined;

    if (!returned) {
      throw new DataServiceError(
        'Upsert conflicted with an existing row your row policy does not allow you to update',
        ROW_POLICY_DENIED,
        403,
      );
    }
    return returned;
  }

  /**
   * Resolves and validates an upsert conflict target (field or column names)
   * to physical column names. Valid targets: the primary key, a single
   * `isUnique` field, or a `constraints.uniqueTogether` group.
   */
  private resolveConflictTarget(objectName: string, onConflict: string[]): string[] {
    const obj = this.registry.getObject(objectName);
    if (!obj) throw new DataServiceError(`Unknown object: ${objectName}`, 'OBJECT_NOT_FOUND', 404);

    const requested = onConflict.map((n) => n.trim()).filter(Boolean);
    if (requested.length === 0) {
      throw new DataServiceError(
        'on_conflict must name at least one column',
        'INVALID_CONFLICT_TARGET',
        400,
      );
    }

    const resolved: FieldDefinition[] = requested.map((name) => {
      const field = obj.fields.find((f) => f.name === name || f.columnName === name);
      if (!field) {
        throw new DataServiceError(
          `Unknown field "${name}" on object "${objectName}"`,
          'UNKNOWN_FIELD',
          400,
        );
      }
      return field;
    });
    const columns = [...new Set(resolved.map((f) => f.columnName))];

    const isDeclaredUnique =
      (columns.length === 1 &&
        (resolved[0]?.isPrimary === true || resolved[0]?.isUnique === true)) ||
      matchesUniqueTogether(columns, obj.constraints?.uniqueTogether);

    if (!isDeclaredUnique) {
      const validTargets = [
        ...obj.fields.filter((f) => f.isPrimary || f.isUnique).map((f) => f.name),
        ...(obj.constraints?.uniqueTogether ?? []).map((g) => `(${g.join(', ')})`),
      ];
      throw new DataServiceError(
        `on_conflict target (${requested.join(', ')}) is not a unique constraint on "${objectName}". Valid targets: ${
          validTargets.join(', ') ||
          'none — mark a field isUnique or declare constraints.uniqueTogether'
        }`,
        'INVALID_CONFLICT_TARGET',
        400,
      );
    }

    return columns;
  }

  /**
   * Updates an existing record by ID. When events are enabled the prior row is
   * read in the same transaction to compute a system-field-free diff carried on
   * the `data.<object>.updated` event.
   *
   * Numeric fields accept **atomic operators** (issue #9): a value of
   * `{ "$inc": n }` (or `{ "$dec": n }`) compiles to `SET col = col + n` in
   * the same single UPDATE statement, so concurrent counters never lose
   * updates. Constraint pre-checks skip incremented columns (the resulting
   * value is unknowable client-side) — the generated CHECK constraints in
   * Postgres remain the enforcement.
   */
  async update(
    objectName: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<SingleResult | null> {
    const tableName = this.resolveTable(objectName);
    const cleanData = this.sanitizeInput(objectName, data);
    const { sets, increments } = splitAtomicOperations(
      this.registry.getFields(objectName),
      cleanData,
    );
    this.validateConstraints(objectName, sets);
    this.stampActor(objectName, sets, 'update');

    const updateValues: Record<string, unknown> = { ...sets };
    for (const [column, amount] of Object.entries(increments)) {
      updateValues[column] = sql`${sql.ref(column)} + ${amount}`;
    }
    if (Object.keys(updateValues).length === 0) {
      throw new DataServiceError('Update body contains no writable fields', 'EMPTY_UPDATE', 400);
    }

    // Row policy (issue #7): the policy joins the WHERE, so a row the actor
    // cannot see is a row they cannot touch — it 404s like a missing one.
    // Reassigning a policy-matched column to a foreign value is rejected.
    const rowPolicy = await this.policyFor('update', objectName);
    this.assertNoPolicyReassignment(sets, rowPolicy);

    const row = await this.translated(
      this.db.transaction().execute(async (trx) => {
        const before = this.eventsEnabled
          ? await trx.selectFrom(tableName).selectAll().where('id', '=', id).executeTakeFirst()
          : undefined;

        const after = await this.applyRowPolicy(
          trx.updateTable(tableName).set(updateValues).where('id', '=', id),
          rowPolicy,
        )
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
      }),
    );

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

    // Row policy (issue #7): out-of-policy rows 404 like missing ones.
    const rowPolicy = await this.policyFor('delete', objectName);
    const deleted = await this.translated(
      this.db.transaction().execute(async (trx) => {
        const row = await this.applyRowPolicy(
          trx.deleteFrom(tableName).where('id', '=', id),
          rowPolicy,
        )
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
      }),
    );

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
    const createPolicy = await this.policyFor('create', objectName);
    for (const record of cleanRecords) {
      this.validateConstraints(objectName, record);
      this.stampActor(objectName, record, 'create');
      this.assertCreateAllowed(objectName, record, createPolicy);
    }

    const rows = await this.translated(
      this.db.transaction().execute(async (trx) => {
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
      }),
    );

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

    // Row policy (issue #7): only in-policy rows are deleted; the returned
    // count/ids reflect what actually happened, like unknown ids do today.
    const rowPolicy = await this.policyFor('delete', objectName);
    const rows = await this.translated(
      this.db.transaction().execute(async (trx) => {
        const deleted = (await this.applyRowPolicy(
          trx.deleteFrom(tableName).where('id', 'in', ids),
          rowPolicy,
        )
          .returningAll()
          .execute()) as Record<string, unknown>[];
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
      }),
    );

    this.wake();
    return {
      count: rows.length,
      ids: rows.map((r) => String((r as Record<string, unknown>).id)),
    };
  }

  /**
   * Inserts a row **without** emitting a change event. Used by event consumers
   * (e.g. the audit block's `persist_event` handler) that write into a data
   * object in reaction to an event — emitting here would recurse. Row policies
   * do not apply: this is an internal system path, never reachable from a
   * request surface (and its callers run outside any actor scope anyway).
   */
  async insertSilent(objectName: string, data: Record<string, unknown>): Promise<void> {
    const tableName = this.resolveTable(objectName);
    const cleanData = this.sanitizeInput(objectName, data);
    await this.translated(this.db.insertInto(tableName).values(cleanData).execute());
  }

  // =========================================================================
  // Link Operations (many_to_many junction writes — Phase 13)
  // =========================================================================

  /**
   * Adds many_to_many links between a record and target records. Idempotent —
   * already-linked pairs are skipped via the junction's composite primary key
   * — and transactional: the junction inserts and the `data.<object>.linked`
   * event (carrying only the ids actually added) commit together.
   */
  async addLinks(
    objectName: string,
    id: string,
    relKey: string,
    targetIds: string[],
  ): Promise<{ added: number }> {
    const { key, thisCol, otherCol, junction } = await this.resolveLinkWrite(
      objectName,
      id,
      relKey,
    );
    const unique = [...new Set(targetIds)];
    if (unique.length === 0) return { added: 0 };

    const added = await this.db
      .transaction()
      .execute(async (trx) => {
        const inserted = await trx
          .insertInto(junction)
          .values(unique.map((targetId) => ({ [thisCol]: id, [otherCol]: targetId })))
          .onConflict((oc) => oc.columns([thisCol, otherCol]).doNothing())
          .returningAll()
          .execute();
        const addedIds = (inserted as Record<string, unknown>[]).map((r) => String(r[otherCol]));
        if (this.eventsEnabled && addedIds.length > 0) {
          await this.emitLink(trx, objectName, 'linked', key, id, addedIds);
        }
        return addedIds.length;
      })
      .catch((err) => {
        throw mapLinkWriteError(err, key);
      });

    this.wake();
    return { added };
  }

  /**
   * Removes many_to_many links between a record and target records. Ids that
   * were not linked are ignored; the `data.<object>.unlinked` event carries
   * only the ids actually removed and commits with the junction deletes.
   */
  async removeLinks(
    objectName: string,
    id: string,
    relKey: string,
    targetIds: string[],
  ): Promise<{ removed: number }> {
    const { key, thisCol, otherCol, junction } = await this.resolveLinkWrite(
      objectName,
      id,
      relKey,
    );
    const unique = [...new Set(targetIds)];
    if (unique.length === 0) return { removed: 0 };

    const removed = await this.db
      .transaction()
      .execute(async (trx) => {
        const deleted = await trx
          .deleteFrom(junction)
          .where(thisCol, '=', id)
          .where(otherCol, 'in', unique)
          .returningAll()
          .execute();
        const removedIds = (deleted as Record<string, unknown>[]).map((r) => String(r[otherCol]));
        if (this.eventsEnabled && removedIds.length > 0) {
          await this.emitLink(trx, objectName, 'unlinked', key, id, removedIds);
        }
        return removedIds.length;
      })
      .catch((err) => {
        throw mapLinkWriteError(err, key);
      });

    this.wake();
    return { removed };
  }

  /**
   * Shared preamble for the link writes: resolves the relation key (must be a
   * many_to_many), verifies the record exists, and derives the junction
   * table/columns as seen from this object's side.
   */
  private async resolveLinkWrite(
    objectName: string,
    id: string,
    relKey: string,
  ): Promise<{ key: RelationKey; junction: string; thisCol: string; otherCol: string }> {
    const tableName = this.resolveTable(objectName);
    const obj = this.registry.getObject(objectName);
    const key = obj ? findRelationKey(obj, relKey) : undefined;
    if (!key) {
      throw new DataServiceError(
        `Unknown relationship "${relKey}" on object "${objectName}"`,
        'UNKNOWN_RELATIONSHIP',
        400,
      );
    }
    if (key.via !== 'junction') {
      throw new DataServiceError(
        `Relationship "${relKey}" is not many_to_many — link writes only apply to many_to_many relationships (FK-backed links are set via the record's "${key.rel.name}_id" field)`,
        'NOT_MANY_TO_MANY',
        400,
      );
    }

    // Row policy (issue #7): linking mutates the record's relations, so the
    // record must be within the actor's *update* policy — an out-of-policy
    // record 404s exactly like a missing one.
    const rowPolicy = await this.policyFor('update', objectName);
    const exists = await this.applyRowPolicy(
      this.db.selectFrom(tableName).select('id').where('id', '=', id),
      rowPolicy,
    )
      .executeTakeFirst()
      .catch((err: unknown) => {
        throw mapLinkWriteError(err, key);
      });
    if (!exists) {
      throw new DataServiceError(
        `Record "${id}" not found on "${objectName}"`,
        'RECORD_NOT_FOUND',
        404,
      );
    }

    const isSource = key.rel.sourceObjectName === objectName;
    return { key, ...this.resolveJunction(key.rel, isSource) };
  }

  /** Publishes a `data.<object>.linked|unlinked` event in the caller's transaction. */
  private async emitLink(
    trx: BusTransaction,
    objectName: string,
    op: LinkOperation,
    key: RelationKey,
    id: string,
    targetIds: string[],
  ): Promise<void> {
    const payload: LinkEventPayload = {
      object: objectName,
      id,
      op,
      relationship: key.key,
      targetObject: key.otherObject,
      targetIds,
      actor: currentActor(),
    };
    await this.bus.publish({ topic: `data.${objectName}.${op}`, payload }, trx);
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
      actor: currentActor(),
    };
    await this.bus.publish({ topic: `data.${objectName}.${op}`, payload }, trx);
  }

  /**
   * Stamps the ambient actor onto the system actor columns (Phase 12 /
   * ADR-019): creates set both `created_by` and `updated_by`, updates only
   * `updated_by`. No-op when there is no actor (anonymous/system writes) or
   * the object predates the actor columns (registry-guarded, so a stale
   * schema never produces an unknown-column SQL error).
   */
  private stampActor(
    objectName: string,
    cleanData: Record<string, unknown>,
    op: 'create' | 'update',
  ): void {
    const actorId = currentActorId();
    if (!actorId) return;
    const fields = this.registry.getFields(objectName);
    const hasColumn = (col: string) => fields.some((f) => f.columnName === col);
    if (op === 'create' && hasColumn('created_by')) cleanData.created_by = actorId;
    if (hasColumn('updated_by')) cleanData.updated_by = actorId;
  }

  /** Nudges the dispatcher to drain immediately once a write has committed. */
  private wake(): void {
    if (this.eventsEnabled) this.bus.wake();
  }

  /**
   * Awaits a query, translating Postgres constraint/input errors (unique,
   * foreign-key, not-null, unparseable values) into typed DataServiceErrors
   * (see errors.ts). This is the single seam where raw database errors escape
   * the service, so every surface — REST, GraphQL, MCP — inherits the stable
   * error contract from one place. Unrelated errors pass through untouched.
   */
  private async translated<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (err) {
      throw translatePgError(err);
    }
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
   * Resolves a field definition by API name or physical column name, throwing
   * the same UNKNOWN_FIELD error shape as {@link validateField}.
   */
  private resolveFieldDef(objectName: string, fieldName: string): FieldDefinition {
    const fields = this.registry.getFields(objectName);
    const def =
      fields.find((f) => f.name === fieldName) ?? fields.find((f) => f.columnName === fieldName);
    if (!def) {
      throw new DataServiceError(
        `Unknown field "${fieldName}" on object "${objectName}"`,
        'UNKNOWN_FIELD',
        400,
      );
    }
    return def;
  }

  /**
   * Sanitizes input data by filtering to only known, writable columns.
   * Strips system fields (id, created_at, updated_at) from input.
   * `keepPrimary` retains a supplied primary key (upsert on `id`).
   */
  private sanitizeInput(
    objectName: string,
    data: Record<string, unknown>,
    options: { keepPrimary?: boolean } = {},
  ): Record<string, unknown> {
    const fields = this.registry.getFields(objectName);
    // The primary key is both system and primary; keepPrimary must beat both
    // flags so an upsert on `id` can carry the supplied value.
    const writableFields = fields.filter(
      (f) =>
        (!f.isSystem && !f.isPrimary) || (options.keepPrimary === true && f.isPrimary === true),
    );

    const fieldMap = new Map(writableFields.map((f) => [f.name, f]));
    const columnMap = new Map(writableFields.map((f) => [f.columnName, f]));

    const clean: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      // Match by field name first, then column name
      const field = fieldMap.get(key) ?? columnMap.get(key);
      if (field) {
        clean[field.columnName] = serializeForColumn(field, value);
      }
    }

    return clean;
  }

  /**
   * Attaches one relation's records under its key to already-fetched rows, in
   * one batched fetch. This is the shared hydration unit: `expand=` loops it,
   * and the GraphQL relation loader (api/graphql) batches parent rows from
   * many resolvers into a single call. Unknown keys are ignored (lenient,
   * like unknown select fields). See `relation-keys.ts` for the key grammar.
   */
  async hydrateRelation(
    objectName: string,
    rows: Record<string, unknown>[],
    relKey: string,
  ): Promise<void> {
    await this.applyExpansions(objectName, rows, [relKey]);
  }

  /**
   * Attaches related records to rows for each requested relation key
   * (Phase 10 / Tier 3B; reverse + shared-with-GraphQL since Phase 13).
   *
   * Supported shapes (see `relation-keys.ts` for how keys are derived):
   * - `via: 'fk'` — FK on **this** object: one batched `WHERE id IN (…)`
   *   fetch of the other side, each row gains `row[key] = record | null`.
   * - `via: 'reverse'` — FK on the other object (`<fkObj>_by_<rel>`): one
   *   batched fetch of the FK side grouped by FK value; rows gain a list
   *   (or `record | null` for one_to_one).
   * - `via: 'junction'` — many_to_many: one junction fetch + one target
   *   fetch, each row gains `row[key] = record[]`.
   */
  private async applyExpansions(
    objectName: string,
    rows: Record<string, unknown>[],
    expand: string[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const obj = this.registry.getObject(objectName);
    if (!obj) return;

    const keys = new Map(listRelationKeys(obj).map((k) => [k.key, k]));
    for (const name of expand) {
      const key = keys.get(name);
      if (!key) continue;

      // Row policy (issue #7): hydration applies the **target** object's read
      // policy, so a policy-hidden row cannot leak through expand=/GraphQL
      // relation fields — it hydrates as null / is absent from lists, exactly
      // as if the FK pointed at a deleted row.
      const targetPolicy = await this.policyFor('read', key.otherObject);

      if (key.via === 'junction') {
        await this.expandManyToMany(objectName, rows, key.rel, targetPolicy);
      } else if (key.via === 'reverse') {
        await this.expandReverse(rows, key, targetPolicy);
      } else {
        await this.expandForeignKey(objectName, rows, key.rel, targetPolicy);
      }
    }
  }

  /**
   * Expands the non-FK side of a FK-backed relationship (`<fkObj>_by_<rel>`):
   * one batched fetch of the FK-holding rows grouped by their FK value. Each
   * row gains a list (one_to_many / many_to_one) or a single record (the
   * reverse of a one_to_one).
   */
  private async expandReverse(
    rows: Record<string, unknown>[],
    key: RelationKey,
    targetPolicy: CompiledRowPolicy,
  ): Promise<void> {
    const otherTable = this.registry.getTableName(key.otherObject);
    if (!otherTable) return;

    const fkColumn = `${key.rel.name}_id`;
    const empty = () => (key.kind === 'single' ? null : []);
    const ids = [...new Set(rows.map((r) => r.id).filter((v) => v != null))];
    if (ids.length === 0) {
      for (const row of rows) row[key.key] = empty();
      return;
    }

    const related = (await this.applyRowPolicy(
      this.db.selectFrom(otherTable).selectAll().where(fkColumn, 'in', ids),
      targetPolicy,
    ).execute()) as Record<string, unknown>[];

    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const record of related) {
      const parent = String(record[fkColumn]);
      const list = grouped.get(parent) ?? [];
      list.push(record);
      grouped.set(parent, list);
    }
    for (const row of rows) {
      const list = grouped.get(String(row.id)) ?? [];
      row[key.key] = key.kind === 'single' ? (list[0] ?? null) : list;
    }
  }

  /**
   * Expands a FK-backed relationship (many_to_one / one_to_one / one_to_many)
   * where the FK column lives on **this** object: one batched fetch of the
   * other side, each row gains `row[relName] = relatedRecord | null`.
   */
  private async expandForeignKey(
    objectName: string,
    rows: Record<string, unknown>[],
    rel: RelationshipDefinition,
    targetPolicy: CompiledRowPolicy,
  ): Promise<void> {
    // The FK lives on this object when it points outward (many_to_one /
    // one_to_one from here) or when a one_to_many names it as the target.
    const fkOnThisObject =
      rel.type === 'one_to_many'
        ? rel.targetObjectName === objectName
        : rel.sourceObjectName === objectName;
    if (!fkOnThisObject) return;

    const otherObject = rel.type === 'one_to_many' ? rel.sourceObjectName : rel.targetObjectName;
    const otherTable = this.registry.getTableName(otherObject);
    if (!otherTable) return;

    const fkColumn = `${rel.name}_id`;
    const ids = [...new Set(rows.map((r) => r[fkColumn]).filter((v) => v != null))];
    if (ids.length === 0) {
      for (const row of rows) row[rel.name] = null;
      return;
    }
    const related = await this.applyRowPolicy(
      this.db.selectFrom(otherTable).selectAll().where('id', 'in', ids),
      targetPolicy,
    ).execute();
    const byId = new Map((related as Record<string, unknown>[]).map((r) => [String(r.id), r]));
    for (const row of rows) {
      const fk = row[fkColumn];
      row[rel.name] = fk == null ? null : (byId.get(String(fk)) ?? null);
    }
  }

  /** Expands a many_to_many relationship via its junction table. */
  private async expandManyToMany(
    objectName: string,
    rows: Record<string, unknown>[],
    rel: RelationshipDefinition,
    targetPolicy: CompiledRowPolicy,
  ): Promise<void> {
    const isSource = rel.sourceObjectName === objectName;
    const otherObject = isSource ? rel.targetObjectName : rel.sourceObjectName;
    const thisTable = this.registry.getTableName(objectName);
    const otherTable = this.registry.getTableName(otherObject);
    if (!thisTable || !otherTable) return;

    const { junction, thisCol, otherCol } = this.resolveJunction(rel, isSource);

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
        : ((await this.applyRowPolicy(
            this.db.selectFrom(otherTable).selectAll().where('id', 'in', otherIds),
            targetPolicy,
          ).execute()) as Record<string, unknown>[]);

    const grouped = groupLinkedRecords(links, thisCol, otherCol, related);
    for (const row of rows) {
      row[rel.name] = grouped.get(String(row.id)) ?? [];
    }
  }

  /**
   * Resolves a many_to_many relationship's junction table and the column pair
   * as seen from this object's side. Junction info is recorded since Phase 10;
   * falls back to the naming convention for relationships created before that.
   */
  private resolveJunction(
    rel: RelationshipDefinition,
    isSource: boolean,
  ): { junction: string; thisCol: string; otherCol: string } {
    const sourceTable = this.registry.getTableName(rel.sourceObjectName) ?? '';
    const targetTable = this.registry.getTableName(rel.targetObjectName) ?? '';
    const junction = rel.junctionTable ?? `${sourceTable}_${targetTable}`;
    const sourceCol = rel.junctionSourceColumn ?? `${sourceTable}_id`;
    const targetCol = rel.junctionTargetColumn ?? `${targetTable}_id`;
    return {
      junction,
      thisCol: isSource ? sourceCol : targetCol,
      otherCol: isSource ? targetCol : sourceCol,
    };
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
   * of ILIKE matches across the object's text-like columns) plus, when a
   * row policy is in force (issue #7), its AND-ed row-scope fragment.
   */
  private applyConditions(
    // biome-ignore lint/suspicious/noExplicitAny: Kysely query types are dynamic
    query: any,
    objectName: string,
    options: QueryOptions,
    rowPolicy?: CompiledRowPolicy,
    // biome-ignore lint/suspicious/noExplicitAny: Kysely query types are dynamic
  ): any {
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

    return this.applyRowPolicy(q, rowPolicy ?? ROW_POLICY_ALL);
  }

  // =========================================================================
  // Row-level policies (issue #7 — see the class JSDoc)
  // =========================================================================

  /**
   * Resolves the ambient principal's compiled row policy for an (action,
   * object) pair, or `all` when no enforcer is wired (enforcement off).
   */
  private async policyFor(
    action: 'create' | 'read' | 'update' | 'delete',
    objectName: string,
  ): Promise<CompiledRowPolicy> {
    if (!this.rowPolicies) return ROW_POLICY_ALL;
    return this.rowPolicies.resolve(action, objectName);
  }

  /**
   * ANDs a compiled row policy into a query's WHERE: `all` is a no-op,
   * `none` is `WHERE false` (so reads report zero rows and writes touch
   * none, with correct counts everywhere), and `match` ORs its conditions.
   * `qualify` prefixes column refs with the table name — required inside
   * `ON CONFLICT DO UPDATE`, where the bare name must address the existing
   * row unambiguously.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Kysely query types are dynamic
  private applyRowPolicy(query: any, policy: CompiledRowPolicy, qualify?: string): any {
    if (policy.kind === 'all') return query;
    if (policy.kind === 'none') return query.where(sql`false`);
    // biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder is dynamic here
    return query.where((eb: any) =>
      eb.or(policy.conditions.map((cond) => rowConditionSql(cond, qualify))),
    );
  }

  /**
   * Guards create/bulk-create/upsert-insert against a restricted create
   * policy: the written row must be one the policy matches. For an `equals`
   * condition on an unset column the actor's id is stamped in (the "rows the
   * actor will own" contract — `own` needs no stamping because `created_by`
   * is a system column that is always actor-stamped and never client-
   * writable); a present-but-foreign value fails the branch. `contains`
   * branches require the supplied array to include the actor (nothing is
   * auto-stamped — guessing at array shapes would be worse than refusing).
   */
  private assertCreateAllowed(
    objectName: string,
    cleanData: Record<string, unknown>,
    policy: CompiledRowPolicy,
  ): void {
    if (policy.kind === 'all') return;
    if (policy.kind === 'match' && policy.conditions.some((c) => satisfyCreate(cleanData, c))) {
      return;
    }
    throw new DataServiceError(
      `Your row policy on "${objectName}" does not allow creating this row — own-scoped creates must belong to you`,
      ROW_POLICY_DENIED,
      403,
    );
  }

  /**
   * Rejects an update that would reassign a policy-matched `equals` column to
   * a foreign value (e.g. handing your row to another user — or planting one
   * in their view). Only plain sets are considered; atomic increments cannot
   * target policy columns meaningfully.
   */
  private assertNoPolicyReassignment(
    sets: Record<string, unknown>,
    policy: CompiledRowPolicy,
  ): void {
    if (policy.kind !== 'match') return;
    for (const cond of policy.conditions) {
      if (cond.op !== 'equals') continue;
      const value = sets[cond.column];
      if (value !== undefined && String(value) !== cond.value) {
        throw new DataServiceError(
          `Your row policy does not allow setting "${cond.column}" to another principal's id`,
          ROW_POLICY_DENIED,
          403,
        );
      }
    }
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
 * Prepares one input value for parameter binding based on the column's
 * declared type. `json` columns accept objects and arrays natively: we
 * stringify them here because node-postgres would otherwise serialize a JS
 * array as a Postgres array literal (`{"1","2"}`) — invalid JSON, a raw
 * 22P02 — and driver inference should never decide what lands in a json
 * column. Pre-encoded JSON strings pass through unchanged for back-compat
 * with clients that already double-encode. Everything else is untouched.
 */
function serializeForColumn(field: FieldDefinition, value: unknown): unknown {
  if (field.columnType === 'json' && typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Renders one compiled row-policy condition as a parameterized SQL boolean
 * (issue #7). `equals` compares the column (text-cast, so uuid/text actor-id
 * columns both work) against the actor id; `contains` matches the actor id
 * inside a `multi_enum` (`text[]` `@>`) or `json` (`jsonb` `@>` against a
 * one-element array) column. A `contains` on any other column type renders
 * `false` — the branch is unmatchable rather than an SQL error.
 */
function rowConditionSql(cond: CompiledRowCondition, qualify?: string) {
  const column = sql.ref(qualify ? `${qualify}.${cond.column}` : cond.column);
  if (cond.op === 'equals') {
    return sql<boolean>`${column}::text = ${cond.value}`;
  }
  if (cond.columnType === 'multi_enum') {
    return sql<boolean>`${column} @> ARRAY[${cond.value}]::text[]`;
  }
  if (cond.columnType === 'json') {
    return sql<boolean>`${column} @> ${JSON.stringify([cond.value])}::jsonb`;
  }
  return sql<boolean>`false`;
}

/**
 * Tries to satisfy one create-policy condition against the row being written,
 * stamping where the contract allows it (see `assertCreateAllowed`): an unset
 * `equals` column is stamped with the actor id and satisfies the branch; a
 * present value must already match/contain the actor.
 */
function satisfyCreate(cleanData: Record<string, unknown>, cond: CompiledRowCondition): boolean {
  const value = cleanData[cond.column];
  if (cond.op === 'equals') {
    if (value === undefined) {
      cleanData[cond.column] = cond.value; // stamp: the actor will own the row
      return true;
    }
    return String(value) === cond.value;
  }
  return createValueContainsActor(value, cond.value);
}

/**
 * Whether a create-path value for a `contains` policy column already includes
 * the actor id. Accepts a JS array or a pre-serialized JSON string (json
 * columns are stringified by {@link serializeForColumn} before this runs).
 */
function createValueContainsActor(value: unknown, actorId: string): boolean {
  let items = value;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      return false;
    }
  }
  return Array.isArray(items) && items.some((item) => String(item) === actorId);
}

/**
 * Escapes the LIKE/ILIKE wildcard metacharacters (`%`, `_`) and the escape
 * character itself so a user's search term is matched literally rather than
 * being interpreted as a pattern. PostgreSQL's default LIKE escape is `\`.
 */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Maps the Postgres errors a link write can hit to friendly 400s: a junction
 * FK violation means a target id doesn't exist on the other side; an invalid
 * text representation means an id wasn't a UUID. Anything else passes through.
 */
function mapLinkWriteError(err: unknown, key: RelationKey): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === '23503') {
    return new DataServiceError(
      `One or more target ids do not exist on "${key.otherObject}"`,
      'UNKNOWN_TARGET',
      400,
    );
  }
  if (code === '22P02') {
    return new DataServiceError('Record ids must be valid UUIDs', 'INVALID_ID', 400);
  }
  return err;
}

/**
 * Groups junction-table links by this-side id, resolving each other-side id to
 * its fetched record (links whose target record is missing are skipped).
 */
function groupLinkedRecords(
  links: Record<string, unknown>[],
  thisCol: string,
  otherCol: string,
  related: Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
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
  return grouped;
}

/** Numeric column types where min/max bound the value (not the length). */
const NUMERIC_CATEGORIES = new Set(['number']);

/**
 * Whether a column type holds numbers an aggregate can sum/average. Mirrors
 * the constraint layer's numeric detection, plus `auto_increment` (a SERIAL —
 * min/max over it is a legitimate read).
 */
function isNumericColumn(columnType: string): boolean {
  const category = COLUMN_TYPES[columnType as keyof typeof COLUMN_TYPES]?.category;
  return (
    NUMERIC_CATEGORIES.has(category) || columnType === 'rating' || columnType === 'auto_increment'
  );
}

/**
 * Coerces an aggregate value from the driver to a JSON number. Postgres
 * returns NUMERIC/BIGINT aggregates as strings (sum/avg always, min/max for
 * those column types); `null` means no rows matched.
 */
function toNumericValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const num = Number(raw);
  return Number.isNaN(num) ? null : num;
}

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
    const problem = numericViolation(value, constraints);
    if (problem) return problem;
  }

  if (typeof value === 'string') {
    const problem = stringViolation(value, columnType, constraints, isNumeric);
    if (problem) return problem;
  }

  if (columnType === 'multi_enum' && Array.isArray(value)) {
    return multiEnumViolation(value, constraints);
  }

  return null;
}

/** Checks a numeric value against min/max bounds. */
function numericViolation(value: number, constraints: FieldConstraints): string | null {
  if (constraints.min !== undefined && value < constraints.min) {
    return `must be at least ${constraints.min}`;
  }
  if (constraints.max !== undefined && value > constraints.max) {
    return `must be at most ${constraints.max}`;
  }
  return null;
}

/** Checks a string value against length bounds, pattern, and enum membership. */
function stringViolation(
  value: string,
  columnType: string,
  constraints: FieldConstraints,
  isNumeric: boolean,
): string | null {
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
  return null;
}

/** Checks a multi_enum array value: every item must be an allowed choice. */
function multiEnumViolation(value: unknown[], constraints: FieldConstraints): string | null {
  if (!constraints.enumValues?.length) return null;
  const invalid = value.filter(
    (v) => typeof v === 'string' && !constraints.enumValues?.includes(v),
  );
  if (invalid.length > 0) {
    return `contains invalid value(s): ${invalid.join(', ')} (allowed: ${constraints.enumValues.join(', ')})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Custom Error (lives in errors.ts with the Postgres translation; re-exported
// here so existing `from './data-service.js'` import sites keep working)
// ---------------------------------------------------------------------------

export { DataServiceError } from './errors.js';
