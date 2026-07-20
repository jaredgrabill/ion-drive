/**
 * Schema Manager — The top-level orchestrator for all schema operations.
 *
 * This is the primary API for creating, modifying, and deleting data objects.
 * It coordinates between the Metadata Store (persistence), DDL Executor
 * (database schema), Schema Registry (cache), and Change Validator (safety).
 *
 * All schema operations follow the same flow:
 * 1. Build a ChangeSet describing the proposed changes
 * 2. Validate the ChangeSet (preview mode — no side effects)
 * 3. If valid, execute the ChangeSet (DDL + metadata + cache update)
 * 4. Record the migration for history (down-SQL is captured per migration,
 *    but no rollback API exists yet — see docs/roadmap.md F9)
 */

import type { Kysely } from 'kysely';
import { nanoid } from 'nanoid';
import { translatePgError } from '../data/errors.js';
import type { SystemDatabase } from '../db/types.js';
import { ChangeValidator } from './change-validator.js';
import { DdlExecutor } from './ddl-executor.js';
import { inferColumnType } from './doctor.js';
import { MetadataStore } from './metadata-store.js';
import { SchemaRegistry } from './schema-registry.js';
import { bootstrapSystemTables } from './system-tables.js';
import { assessTypeChange } from './type-compat.js';
import { COLUMN_TYPES, SYSTEM_FIELDS } from './types.js';
import type {
  ChangePreview,
  ChangeSet,
  DataObjectDefinition,
  FieldDefinition,
  FieldModification,
  ObjectConstraints,
  RelationshipDefinition,
  SchemaChange,
} from './types.js';
import { diffUniqueTogether, resolveUniqueTogether } from './unique-together.js';

/** Options accepted by the destructive/structural field operations. */
export interface FieldChangeOptions {
  /** Validate + preview only; never touch the database. */
  dryRun?: boolean;
  /** Override block contract protection (ADR-017). */
  force?: boolean;
}

export interface SchemaManagerOptions {
  systemDb: Kysely<SystemDatabase>;
  tenantDb: Kysely<Record<string, unknown>>;
}

export class SchemaManager {
  readonly metadataStore: MetadataStore;
  readonly ddlExecutor: DdlExecutor;
  readonly registry: SchemaRegistry;
  readonly validator: ChangeValidator;

  private readonly systemDb: Kysely<SystemDatabase>;

  constructor(options: SchemaManagerOptions) {
    this.systemDb = options.systemDb;
    this.metadataStore = new MetadataStore(options.systemDb);
    this.ddlExecutor = new DdlExecutor(options.tenantDb);
    this.registry = new SchemaRegistry();
    this.validator = new ChangeValidator(this.registry, this.ddlExecutor);
  }

  /**
   * Initializes the Schema Manager:
   * 1. Bootstraps system tables if they don't exist
   * 2. Loads existing schema state into the registry
   * 3. Retrofits newly-introduced system fields onto pre-existing objects
   */
  async initialize(): Promise<void> {
    await bootstrapSystemTables(this.systemDb);
    await this.registry.loadFromStore(this.metadataStore);
    await this.ensureActorFields();
  }

  /**
   * Boot migration (Phase 12 / ADR-019): objects created before actor identity
   * shipped lack the `created_by`/`updated_by` system columns. Adds the columns
   * (`IF NOT EXISTS`) and their `_ion_fields` rows, then re-hydrates each
   * touched object so the registry reflects the new shape. Idempotent — objects
   * that already have both fields are skipped.
   */
  private async ensureActorFields(): Promise<void> {
    const actorFields = SYSTEM_FIELDS.filter(
      (f) => f.columnName === 'created_by' || f.columnName === 'updated_by',
    );
    for (const obj of this.registry.listObjects()) {
      const missing = actorFields.filter(
        (sf) => !obj.fields.some((f) => f.columnName === sf.columnName),
      );
      if (missing.length === 0 || !obj.id) continue;

      for (const field of missing) {
        await this.ddlExecutor.addColumnIfNotExists(obj.tableName, field);
        await this.metadataStore.createField(obj.id, field);
      }
      const fullDef = await this.metadataStore.getFullObjectDefinition(obj.name);
      if (fullDef) this.registry.registerObject(fullDef);
    }
  }

  // =========================================================================
  // Data Object Operations
  // =========================================================================

  /**
   * Creates a new data object (table) with the given definition.
   *
   * This:
   * 1. Validates the object name and fields
   * 2. Creates the PostgreSQL table with system fields (id, created_at, updated_at)
   * 3. Records the object and field metadata
   * 4. Updates the in-memory schema registry
   */
  async createObject(definition: DataObjectDefinition): Promise<{
    preview: ChangePreview;
    success: boolean;
    object?: DataObjectDefinition;
  }> {
    // Ensure tableName is set
    if (!definition.tableName) {
      definition.tableName = definition.name;
    }

    // Build change set
    const changeSet = this.buildChangeSet(`Create object "${definition.name}"`, [
      {
        type: 'create_object',
        objectName: definition.name,
        details: definition as unknown as Record<string, unknown>,
      },
    ]);

    // Validate
    const preview = await this.validator.validateChangeSet(changeSet);
    if (!preview.isValid) {
      return { preview, success: false };
    }

    // Normalize composite unique groups (issue #9) so stored metadata,
    // constraint names, and snapshot exports are all deterministic.
    const uniqueGroups = resolveUniqueTogether(definition.constraints?.uniqueTogether, [
      ...SYSTEM_FIELDS,
      ...definition.fields,
    ]).groups;
    definition.constraints = uniqueGroups.length > 0 ? { uniqueTogether: uniqueGroups } : undefined;

    // Execute
    const sqlStatements = await this.ddlExecutor.createTable(definition);
    for (const group of uniqueGroups) {
      sqlStatements.push(
        ...(await this.ddlExecutor.addUniqueConstraint(definition.tableName, group)),
      );
    }

    // Record metadata
    const objRecord = await this.metadataStore.createObject(definition);

    // Record all fields (system fields + user fields)
    const allFields = [...SYSTEM_FIELDS, ...definition.fields];
    await this.metadataStore.createFields(objRecord.id, allFields);

    // Create auto-indexes for FK and unique fields
    for (const field of definition.fields) {
      if (field.isIndexed || field.isUnique) {
        const indexName = `idx_${definition.tableName}_${field.columnName}`;
        await this.metadataStore.createIndex(objRecord.id, {
          name: `${field.name}_index`,
          indexName,
          columns: [field.columnName],
          isUnique: field.isUnique,
          isAuto: true,
        });
      }
    }

    // Record migration
    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Create object "${definition.name}"`,
      changes: { type: 'create_object', objectName: definition.name },
      sqlUp: sqlStatements.join(';\n'),
      sqlDown: `DROP TABLE IF EXISTS "${definition.tableName}" CASCADE`,
    });

    // Update cache
    const fullDef = await this.metadataStore.getFullObjectDefinition(definition.name);
    if (fullDef) {
      this.registry.registerObject(fullDef);
    }

    return { preview, success: true, object: fullDef ?? undefined };
  }

  /**
   * Deletes a data object and its table.
   *
   * This:
   * 1. Validates the object can be deleted
   * 2. Drops the PostgreSQL table
   * 3. Removes metadata (cascades to fields, relationships, indexes)
   * 4. Updates the in-memory schema registry
   */
  async deleteObject(name: string): Promise<{
    preview: ChangePreview;
    success: boolean;
  }> {
    const changeSet = this.buildChangeSet(`Delete object "${name}"`, [
      {
        type: 'delete_object',
        objectName: name,
        details: {},
      },
    ]);

    const preview = await this.validator.validateChangeSet(changeSet);
    if (!preview.isValid) {
      return { preview, success: false };
    }

    const obj = this.registry.getObject(name);
    if (!obj) {
      return { preview, success: false };
    }

    // Execute DDL. Many-to-many junction tables touching this object are
    // dropped first — they are real tables but not data objects, so the
    // object's own DROP … CASCADE only severs their FKs and would leave them
    // orphaned (surfaced by `block test`'s doctor assertion, spec-06).
    const sqlStatements: string[] = [];
    for (const rel of this.registry.getRelationships(name)) {
      if (rel.type === 'many_to_many' && rel.junctionTable) {
        sqlStatements.push(...(await this.ddlExecutor.dropTable(rel.junctionTable)));
      }
    }
    sqlStatements.push(...(await this.ddlExecutor.dropTable(obj.tableName)));

    // Remove metadata (cascading deletes handle fields, relationships, indexes)
    await this.metadataStore.deleteObject(name);

    // Record migration
    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Delete object "${name}"`,
      changes: { type: 'delete_object', objectName: name },
      sqlUp: sqlStatements.join(';\n'),
    });

    // Update cache
    this.registry.unregisterObject(name);

    return { preview, success: true };
  }

  /**
   * Replaces an object's composite unique groups (`constraints.uniqueTogether`,
   * issue #9). Declarative: the given groups become the full set — missing
   * ones are dropped, new ones are added (delta-computed, so untouched groups
   * never churn). Preview-first like modifyField: `dryRun` returns the
   * ChangePreview (real DDL + live duplicate-data errors) without touching
   * anything; block-owned objects require `force` (ADR-017).
   */
  async setObjectConstraints(
    objectName: string,
    constraints: ObjectConstraints,
    options: FieldChangeOptions = {},
  ): Promise<{
    preview: ChangePreview;
    success: boolean;
    object?: DataObjectDefinition;
  }> {
    const changeSet = this.buildChangeSet(`Update constraints on "${objectName}"`, [
      {
        type: 'modify_object',
        objectName,
        details: {
          constraints: constraints as unknown as Record<string, unknown>,
          force: options.force,
        },
      },
    ]);

    const preview = await this.validator.validateChangeSet(changeSet);
    if (options.dryRun) return { preview, success: preview.isValid };
    if (!preview.isValid) return { preview, success: false };

    const obj = this.registry.getObject(objectName);
    if (!obj) return { preview, success: false };

    const current = resolveUniqueTogether(obj.constraints?.uniqueTogether, obj.fields).groups;
    const target = resolveUniqueTogether(constraints.uniqueTogether, obj.fields).groups;
    const { added, removed } = diffUniqueTogether(current, target);

    const executed: string[] = [];
    for (const group of removed) {
      // Find the live constraint by column set — it may predate our naming.
      const name = await this.ddlExecutor.findUniqueConstraintForColumns(obj.tableName, group);
      if (name) {
        executed.push(...(await this.ddlExecutor.dropConstraintByName(obj.tableName, name)));
      }
    }
    for (const group of added) {
      try {
        executed.push(...(await this.ddlExecutor.addUniqueConstraint(obj.tableName, group)));
      } catch (err) {
        // Drift guard (issue #23): when the physical ion_uq_* constraint
        // survived but metadata lost the group, re-applying it raises 42P07
        // ("relation already exists" — the constraint's backing index).
        // Translate it to the platform contract (409 `already_exists`, naming
        // the constraint) instead of letting a raw Postgres 500 escape.
        throw translatePgError(err);
      }
    }

    await this.metadataStore.updateObject(objectName, {
      constraints: target.length > 0 ? { uniqueTogether: target } : null,
    });

    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Update constraints on "${objectName}"`,
      changes: { type: 'modify_object', objectName, constraints: { uniqueTogether: target } },
      sqlUp: executed.join(';\n') || '-- metadata-only change',
    });

    await this.refreshObject(objectName);
    return { preview, success: true, object: this.registry.getObject(objectName) };
  }

  // =========================================================================
  // Field Operations
  // =========================================================================

  /**
   * Adds a field (column) to an existing data object.
   */
  async addField(
    objectName: string,
    field: FieldDefinition,
  ): Promise<{
    preview: ChangePreview;
    success: boolean;
  }> {
    // Ensure columnName is set
    if (!field.columnName) {
      field.columnName = field.name;
    }

    const changeSet = this.buildChangeSet(`Add field "${field.name}" to "${objectName}"`, [
      {
        type: 'add_field',
        objectName,
        details: field as unknown as Record<string, unknown>,
      },
    ]);

    const preview = await this.validator.validateChangeSet(changeSet);
    if (!preview.isValid) {
      return { preview, success: false };
    }

    const obj = this.registry.getObject(objectName);
    if (!obj?.id) {
      return { preview, success: false };
    }

    // Execute DDL
    await this.ddlExecutor.addColumn(obj.tableName, field);

    // Record metadata
    const metaObj = await this.metadataStore.getObject(objectName);
    if (metaObj) {
      await this.metadataStore.createField(metaObj.id, field);

      // Auto-create index if needed
      if (field.isIndexed || field.isUnique) {
        const indexName = `idx_${obj.tableName}_${field.columnName}`;
        await this.metadataStore.createIndex(metaObj.id, {
          name: `${field.name}_index`,
          indexName,
          columns: [field.columnName],
          isUnique: field.isUnique,
          isAuto: true,
        });
      }
    }

    // Record migration
    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Add field "${field.name}" to "${objectName}"`,
      changes: { type: 'add_field', objectName, field: field.name },
      sqlUp: `ALTER TABLE "${obj.tableName}" ADD COLUMN "${field.columnName}" ...`,
      sqlDown: `ALTER TABLE "${obj.tableName}" DROP COLUMN "${field.columnName}"`,
    });

    // Update cache
    this.registry.addField(objectName, field);

    return { preview, success: true };
  }

  /**
   * Modifies an existing field: rename, type change, flag toggles, default,
   * constraints, and/or presentation metadata — validated and previewed as one
   * ChangeSet, then executed step-wise (type → default → required → unique →
   * index → rename last, so earlier steps address the original column name).
   *
   * With `options.dryRun` the preview is returned without touching anything —
   * this is the contract the admin designer builds its confirm step on.
   */
  async modifyField(
    objectName: string,
    fieldName: string,
    updates: FieldModification,
    options: FieldChangeOptions = {},
  ): Promise<{
    preview: ChangePreview;
    success: boolean;
    field?: FieldDefinition;
  }> {
    const changeSet = this.buildChangeSet(`Modify field "${fieldName}" on "${objectName}"`, [
      {
        type: 'modify_field',
        objectName,
        details: { fieldName, updates: updates as Record<string, unknown>, force: options.force },
      },
    ]);

    const preview = await this.validator.validateChangeSet(changeSet);
    if (options.dryRun) return { preview, success: preview.isValid };
    if (!preview.isValid) return { preview, success: false };

    const obj = this.registry.getObject(objectName);
    const field = obj?.fields.find((f) => f.name === fieldName);
    const metaObj = await this.metadataStore.getObject(objectName);
    if (!obj || !field?.id || !metaObj) {
      return { preview, success: false };
    }

    const executed = await this.executeFieldModification(obj, field, updates);

    // Persist metadata (a rename also renames the column to match the new name).
    const { backfillValue: _backfill, name: newName, ...metaUpdates } = updates;
    await this.metadataStore.updateField(field.id, {
      ...metaUpdates,
      ...(newName !== undefined ? { name: newName, columnName: newName } : {}),
    });
    await this.syncIndexMetadata(metaObj.id, obj.tableName, field, updates);

    // Record migration + refresh the cache from the store.
    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Modify field "${fieldName}" on "${objectName}"`,
      changes: { type: 'modify_field', objectName, field: fieldName, updates },
      sqlUp: executed.join(';\n') || '-- metadata-only change',
    });

    const fullDef = await this.metadataStore.getFullObjectDefinition(objectName);
    if (fullDef) this.registry.registerObject(fullDef);

    const updatedField = fullDef?.fields.find((f) => f.name === (updates.name ?? fieldName));
    return { preview, success: true, field: updatedField };
  }

  /**
   * Renames a field (and its column). Sugar over {@link modifyField} — the
   * preview carries the API-surface-change warning.
   */
  async renameField(
    objectName: string,
    oldName: string,
    newName: string,
    options: FieldChangeOptions = {},
  ): Promise<{
    preview: ChangePreview;
    success: boolean;
    field?: FieldDefinition;
  }> {
    return this.modifyField(objectName, oldName, { name: newName }, options);
  }

  /** Executes the DDL steps of a field modification, returning the SQL run. */
  private async executeFieldModification(
    obj: DataObjectDefinition,
    field: FieldDefinition,
    updates: FieldModification,
  ): Promise<string[]> {
    const executed: string[] = [];
    const { ddlExecutor } = this;
    const table = obj.tableName;
    const column = field.columnName;

    // CHECK constraints are dropped up front whenever the type, name, or the
    // constraints themselves change (a length check would block an ALTER TYPE
    // to a number; names embed the column), and re-created at the end against
    // the field's final shape.
    const needsConstraintSync = constraintSyncNeeded(field, updates);
    if (needsConstraintSync) {
      executed.push(...(await ddlExecutor.dropCheckConstraints(table, column)));
    }

    if (updates.columnType !== undefined && updates.columnType !== field.columnType) {
      const assessment = assessTypeChange(field.columnType, updates.columnType);
      const usingCast =
        assessment.compatible && assessment.usingCast ? assessment.usingCast : undefined;
      executed.push(
        ...(await ddlExecutor.alterColumnType(
          table,
          column,
          COLUMN_TYPES[updates.columnType].pg,
          usingCast,
        )),
      );
    }

    executed.push(...(await this.executeFlagChanges(table, column, field, updates)));

    // Rename last so every step above operated on the original column name.
    if (updates.name !== undefined && updates.name !== field.name) {
      executed.push(...(await ddlExecutor.renameColumn(table, column, updates.name)));
    }

    // Re-create CHECK constraints against the final column name/type/rules.
    if (needsConstraintSync) {
      executed.push(...(await this.recreateCheckConstraints(table, column, field, updates)));
    }

    return executed;
  }

  /**
   * Runs the default/required/unique/indexed toggle steps of a field
   * modification (in that order), skipping flags that aren't actually changing.
   */
  private async executeFlagChanges(
    table: string,
    column: string,
    field: FieldDefinition,
    updates: FieldModification,
  ): Promise<string[]> {
    const executed: string[] = [];
    const { ddlExecutor } = this;

    if (updates.defaultValue !== undefined) {
      executed.push(
        ...(updates.defaultValue === null || updates.defaultValue === ''
          ? await ddlExecutor.dropColumnDefault(table, column)
          : await ddlExecutor.setColumnDefault(table, column, updates.defaultValue)),
      );
    }

    if (updates.isRequired !== undefined && updates.isRequired !== (field.isRequired ?? false)) {
      executed.push(
        ...(updates.isRequired
          ? await ddlExecutor.setNotNull(table, column, updates.backfillValue)
          : await ddlExecutor.dropNotNull(table, column)),
      );
    }

    executed.push(...(await this.executeUniqueAndIndexToggles(table, column, field, updates)));

    return executed;
  }

  /** Runs the unique-constraint and index toggle steps of a field modification. */
  private async executeUniqueAndIndexToggles(
    table: string,
    column: string,
    field: FieldDefinition,
    updates: FieldModification,
  ): Promise<string[]> {
    const executed: string[] = [];
    const { ddlExecutor } = this;

    if (updates.isUnique !== undefined && updates.isUnique !== (field.isUnique ?? false)) {
      executed.push(
        ...(updates.isUnique
          ? await ddlExecutor.addUniqueConstraint(table, column)
          : await ddlExecutor.dropUniqueConstraint(table, column)),
      );
    }

    if (updates.isIndexed !== undefined && updates.isIndexed !== (field.isIndexed ?? false)) {
      const indexName = `idx_${table}_${column}`;
      executed.push(
        ...(updates.isIndexed
          ? await ddlExecutor.createIndex(indexName, table, [column])
          : await ddlExecutor.dropIndex(indexName)),
      );
    }

    return executed;
  }

  /**
   * Re-creates a modified field's CHECK constraints against its final
   * name/type/rules (constraints dropped up front by the caller). No-op when
   * the modification cleared the constraints entirely.
   */
  private async recreateCheckConstraints(
    table: string,
    column: string,
    field: FieldDefinition,
    updates: FieldModification,
  ): Promise<string[]> {
    const effectiveConstraints =
      updates.constraints === null ? undefined : (updates.constraints ?? field.constraints);
    if (!effectiveConstraints) return [];
    return this.ddlExecutor.addCheckConstraints(table, {
      ...field,
      columnName: updates.name ?? column,
      columnType: updates.columnType ?? field.columnType,
      constraints: effectiveConstraints,
    });
  }

  /** Keeps the `_ion_indexes` ledger in step with an isIndexed toggle. */
  private async syncIndexMetadata(
    objectId: string,
    tableName: string,
    field: FieldDefinition,
    updates: FieldModification,
  ): Promise<void> {
    if (updates.isIndexed === undefined || updates.isIndexed === (field.isIndexed ?? false)) {
      return;
    }
    const indexName = `idx_${tableName}_${field.columnName}`;
    if (updates.isIndexed) {
      await this.metadataStore.createIndex(objectId, {
        name: `${field.name}_index`,
        indexName,
        columns: [field.columnName],
        isAuto: true,
      });
      return;
    }
    const existing = (await this.metadataStore.getIndexes(objectId)).find(
      (idx) => idx.index_name === indexName,
    );
    if (existing) await this.metadataStore.deleteIndex(existing.id);
  }

  /**
   * Removes a field (column) from a data object.
   */
  async removeField(
    objectName: string,
    fieldName: string,
    options: FieldChangeOptions = {},
  ): Promise<{
    preview: ChangePreview;
    success: boolean;
  }> {
    const changeSet = this.buildChangeSet(`Remove field "${fieldName}" from "${objectName}"`, [
      {
        type: 'remove_field',
        objectName,
        details: { fieldName, force: options.force },
      },
    ]);

    const preview = await this.validator.validateChangeSet(changeSet);
    if (options.dryRun) return { preview, success: preview.isValid };
    if (!preview.isValid) {
      return { preview, success: false };
    }

    const obj = this.registry.getObject(objectName);
    const field = obj?.fields.find((f) => f.name === fieldName);
    if (!obj || !field) {
      return { preview, success: false };
    }

    // Execute DDL
    await this.ddlExecutor.dropColumn(obj.tableName, field.columnName);

    // Remove metadata
    const metaObj = await this.metadataStore.getObject(objectName);
    if (metaObj) {
      const metaField = await this.metadataStore.getField(metaObj.id, fieldName);
      if (metaField) {
        await this.metadataStore.deleteField(metaField.id);
      }
    }

    // Record migration
    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Remove field "${fieldName}" from "${objectName}"`,
      changes: { type: 'remove_field', objectName, field: fieldName },
      sqlUp: `ALTER TABLE "${obj.tableName}" DROP COLUMN "${field.columnName}"`,
    });

    // Update cache
    this.registry.removeField(objectName, fieldName);

    return { preview, success: true };
  }

  // =========================================================================
  // Relationship Operations
  // =========================================================================

  /**
   * Creates a relationship between two data objects.
   */
  async addRelationship(relationship: RelationshipDefinition): Promise<{
    preview: ChangePreview;
    success: boolean;
  }> {
    const changeSet = this.buildChangeSet(
      `Add ${relationship.type} relationship "${relationship.name}"`,
      [
        {
          type: 'add_relationship',
          objectName: relationship.sourceObjectName,
          details: relationship as unknown as Record<string, unknown>,
        },
      ],
    );

    const preview = await this.validator.validateChangeSet(changeSet);
    if (!preview.isValid) {
      return { preview, success: false };
    }

    const sourceObj = this.registry.getObject(relationship.sourceObjectName);
    const targetObj = this.registry.getObject(relationship.targetObjectName);
    if (!sourceObj || !targetObj) {
      return { preview, success: false };
    }

    const sourceMetaObj = await this.metadataStore.getObject(relationship.sourceObjectName);
    const targetMetaObj = await this.metadataStore.getObject(relationship.targetObjectName);
    if (!sourceMetaObj || !targetMetaObj) {
      return { preview, success: false };
    }

    let sourceFieldId: string | undefined;

    if (
      relationship.type === 'one_to_one' ||
      relationship.type === 'one_to_many' ||
      relationship.type === 'many_to_one'
    ) {
      sourceFieldId = await this.createRelationshipFkColumn(relationship, sourceObj, targetObj);
    } else if (relationship.type === 'many_to_many') {
      await this.createRelationshipJunction(relationship, sourceObj, targetObj);
    }

    // Record relationship metadata
    await this.metadataStore.createRelationship(
      relationship,
      sourceMetaObj.id,
      targetMetaObj.id,
      sourceFieldId,
      undefined,
      relationship.junctionTable
        ? {
            table: relationship.junctionTable,
            sourceColumn: relationship.junctionSourceColumn ?? '',
            targetColumn: relationship.junctionTargetColumn ?? '',
          }
        : undefined,
    );

    // Record migration
    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Add ${relationship.type} relationship "${relationship.name}"`,
      changes: { type: 'add_relationship', relationship: relationship.name },
      sqlUp: `-- Relationship: ${relationship.name}`,
    });

    // Update cache: re-hydrate both endpoints so their relationship lists and
    // the FK field on the holding side are live immediately (expand, snapshot
    // export, and the admin designer all read them from the object defs).
    await this.refreshObject(relationship.sourceObjectName);
    await this.refreshObject(relationship.targetObjectName);

    return { preview, success: true };
  }

  /**
   * FK-backed relationship setup (one_to_one / one_to_many / many_to_one):
   * adds the `<name>_id` column on the "many" side (target for one_to_many,
   * source otherwise), the FK constraint, and the field metadata. Returns the
   * created field's id for the relationship record.
   */
  private async createRelationshipFkColumn(
    relationship: RelationshipDefinition,
    sourceObj: DataObjectDefinition,
    targetObj: DataObjectDefinition,
  ): Promise<string | undefined> {
    // Create FK column on the "many" side (or source for one_to_one)
    const fkTable = relationship.type === 'one_to_many' ? targetObj.tableName : sourceObj.tableName;
    const fkObjectName =
      relationship.type === 'one_to_many'
        ? relationship.targetObjectName
        : relationship.sourceObjectName;
    const referencedTable =
      relationship.type === 'one_to_many' ? sourceObj.tableName : targetObj.tableName;

    const fkColumnName = `${relationship.name}_id`;
    const fkField: FieldDefinition = {
      name: fkColumnName,
      displayName: `${relationship.displayName} ID`,
      columnName: fkColumnName,
      columnType: 'uuid',
      isIndexed: true,
      managedBy: relationship.managedBy,
    };

    // Add the FK column
    await this.ddlExecutor.addColumn(fkTable, fkField);

    // Add the FK constraint
    const onDelete = relationship.cascadeDelete ? 'CASCADE' : 'RESTRICT';
    await this.ddlExecutor.addForeignKey(
      fkTable,
      fkColumnName,
      referencedTable,
      'id',
      onDelete as 'CASCADE' | 'SET NULL' | 'RESTRICT',
    );

    // Record field metadata
    const fkMetaObj = await this.metadataStore.getObject(fkObjectName);
    if (!fkMetaObj) return undefined;
    const fieldRecord = await this.metadataStore.createField(fkMetaObj.id, fkField);
    return fieldRecord.id;
  }

  /**
   * Removes a relationship (Phase 13 / F17). Relationship names are scoped
   * per source object, so the address is the (sourceObject, name) pair.
   *
   * Preview-first like modifyField: `dryRun` returns the ChangePreview (real
   * SQL + data-loss warnings — the FK column's values or the junction table's
   * link rows are permanently deleted) without touching anything; block-owned
   * relationships require `force` (ADR-017). Execution: FK-backed → drop the
   * FK column (constraint and index go with it) and its `_ion_fields` row;
   * many_to_many → drop the junction table. Then the `_ion_relationships` row
   * is deleted, the migration recorded, and both endpoints re-hydrated.
   */
  async removeRelationship(
    sourceObjectName: string,
    relationshipName: string,
    options: FieldChangeOptions = {},
  ): Promise<{ preview: ChangePreview; success: boolean }> {
    const changeSet = this.buildChangeSet(
      `Remove relationship "${relationshipName}" from "${sourceObjectName}"`,
      [
        {
          type: 'remove_relationship',
          objectName: sourceObjectName,
          details: { relationshipName, force: options.force === true },
        },
      ],
    );

    const preview = await this.validator.validateChangeSet(changeSet);
    if (options.dryRun) return { preview, success: preview.isValid };
    if (!preview.isValid) return { preview, success: false };

    const sourceObj = this.registry.getObject(sourceObjectName);
    const rel = sourceObj?.relationships?.find((r) => r.name === relationshipName);
    const targetObj = rel ? this.registry.getObject(rel.targetObjectName) : undefined;
    if (!sourceObj || !rel?.id || !targetObj) {
      return { preview, success: false };
    }

    if (rel.type === 'many_to_many') {
      const junction = rel.junctionTable ?? `${sourceObj.tableName}_${targetObj.tableName}`;
      await this.ddlExecutor.dropTable(junction);
    } else {
      // The FK column lives on the "many" side (target for one_to_many).
      const fkObj = rel.type === 'one_to_many' ? targetObj : sourceObj;
      const fkColumn = `${rel.name}_id`;
      const fkField = fkObj.fields.find((f) => f.columnName === fkColumn);
      await this.ddlExecutor.dropColumn(fkObj.tableName, fkColumn);
      if (fkField?.id) await this.metadataStore.deleteField(fkField.id);
    }

    await this.metadataStore.deleteRelationship(rel.id);

    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Remove ${rel.type} relationship "${relationshipName}" from "${sourceObjectName}"`,
      changes: {
        type: 'remove_relationship',
        relationship: relationshipName,
        sourceObject: sourceObjectName,
      },
      sqlUp: preview.sqlStatements.join(';\n'),
    });

    // Re-hydrate both endpoints so relationship lists and the dropped FK
    // field disappear from expand/snapshot/designer immediately.
    await this.refreshObject(rel.sourceObjectName);
    await this.refreshObject(rel.targetObjectName);

    return { preview, success: true };
  }

  /**
   * many_to_many relationship setup: creates the junction table and stamps its
   * name/columns onto the relationship (recorded in `_ion_relationships` so
   * expand can find it later).
   */
  private async createRelationshipJunction(
    relationship: RelationshipDefinition,
    sourceObj: DataObjectDefinition,
    targetObj: DataObjectDefinition,
  ): Promise<void> {
    const junctionTable = `${sourceObj.tableName}_${targetObj.tableName}`;
    const sourceCol = `${sourceObj.tableName}_id`;
    const targetCol = `${targetObj.tableName}_id`;

    await this.ddlExecutor.createJunctionTable(
      junctionTable,
      sourceObj.tableName,
      targetObj.tableName,
      sourceCol,
      targetCol,
    );
    relationship.junctionTable = junctionTable;
    relationship.junctionSourceColumn = sourceCol;
    relationship.junctionTargetColumn = targetCol;
  }

  // =========================================================================
  // Drift adoption (Phase 10 — the doctor's "adopt" action)
  // =========================================================================

  /**
   * Imports an unmanaged database column into metadata (no DDL — the column
   * already exists). The field becomes a normal user-managed field, so it
   * immediately appears on REST/GraphQL/MCP.
   */
  async adoptColumn(
    objectName: string,
    columnName: string,
  ): Promise<{ success: boolean; error?: string; field?: FieldDefinition }> {
    const obj = this.registry.getObject(objectName);
    const metaObj = await this.metadataStore.getObject(objectName);
    if (!obj || !metaObj) return { success: false, error: `Unknown object "${objectName}"` };
    if (obj.fields.some((f) => f.columnName === columnName)) {
      return { success: false, error: `Column "${columnName}" is already managed` };
    }

    const catalog = await this.ddlExecutor.describeTable(obj.tableName);
    const col = catalog.find((c) => c.column_name === columnName);
    if (!col) {
      return { success: false, error: `Column "${columnName}" not found on "${obj.tableName}"` };
    }

    const field: FieldDefinition = {
      name: columnName,
      displayName: titleCase(columnName),
      columnName,
      columnType: inferColumnType(col),
      isRequired: col.is_nullable === 'NO',
      defaultValue: col.column_default ?? undefined,
      managedBy: 'user',
    };
    await this.metadataStore.createField(metaObj.id, field);
    await this.recordAdoptionMigration(`Adopt column "${objectName}.${columnName}"`);
    await this.refreshObject(objectName);
    return { success: true, field: this.registry.getField(objectName, columnName) };
  }

  /**
   * Imports an entire unmanaged table into metadata as a new data object.
   * Columns named like the platform's system fields (id/created_at/updated_at)
   * are marked system so the API treats them normally.
   */
  async adoptTable(
    tableName: string,
  ): Promise<{ success: boolean; error?: string; object?: DataObjectDefinition }> {
    if (this.listObjects().some((o) => o.tableName === tableName)) {
      return { success: false, error: `Table "${tableName}" is already managed` };
    }
    const catalog = await this.ddlExecutor.describeTable(tableName);
    if (catalog.length === 0) {
      return { success: false, error: `Table "${tableName}" not found` };
    }

    const systemNames = new Set(SYSTEM_FIELDS.map((f) => f.name));
    const objRecord = await this.metadataStore.createObject({
      name: tableName,
      displayName: titleCase(tableName),
      tableName,
      managedBy: 'user',
      fields: [],
    });
    const fields: FieldDefinition[] = catalog.map((col) => ({
      name: col.column_name,
      displayName: titleCase(col.column_name),
      columnName: col.column_name,
      columnType: inferColumnType(col),
      isRequired: col.is_nullable === 'NO',
      isPrimary: col.column_name === 'id',
      isSystem: systemNames.has(col.column_name),
      defaultValue: col.column_default ?? undefined,
      managedBy: systemNames.has(col.column_name) ? 'system' : 'user',
    }));
    await this.metadataStore.createFields(objRecord.id, fields);
    await this.recordAdoptionMigration(`Adopt table "${tableName}" as a data object`);
    await this.refreshObject(tableName);
    return { success: true, object: this.registry.getObject(tableName) };
  }

  /**
   * Releases a block-managed object or field to `user` management (spec-07's
   * upgrade contract: items the old block version created but the new manifest
   * no longer declares become the user's, like vendored code). Metadata-only —
   * no DDL runs; the migration trail records the flip. Releasing a whole
   * object also flips every field that carried the object's prior provenance
   * (fields stamped by *other* blocks keep their owner).
   */
  async releaseToUser(
    objectName: string,
    fieldName?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const obj = this.registry.getObject(objectName);
    const metaObj = await this.metadataStore.getObject(objectName);
    if (!obj || !metaObj) return { success: false, error: `Unknown object "${objectName}"` };

    if (fieldName !== undefined) {
      const field = obj.fields.find((f) => f.name === fieldName);
      if (!field?.id) {
        return { success: false, error: `Unknown field "${objectName}.${fieldName}"` };
      }
      await this.metadataStore.updateField(field.id, { managedBy: 'user' });
      await this.recordAdoptionMigration(
        `Release field "${objectName}.${fieldName}" to user management`,
      );
      await this.refreshObject(objectName);
      return { success: true };
    }

    const priorOwner = obj.managedBy;
    await this.metadataStore.updateObject(objectName, { managedBy: 'user' });
    for (const field of obj.fields) {
      if (field.id && priorOwner !== undefined && field.managedBy === priorOwner) {
        await this.metadataStore.updateField(field.id, { managedBy: 'user' });
      }
    }
    await this.recordAdoptionMigration(`Release object "${objectName}" to user management`);
    await this.refreshObject(objectName);
    return { success: true };
  }

  /** Records an adoption in the migration history (metadata-only change). */
  private async recordAdoptionMigration(description: string): Promise<void> {
    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description,
      changes: { type: 'adopt' },
      sqlUp: '-- metadata-only: adopted existing database structure',
    });
  }

  /** Re-hydrates one object from the store into the registry. */
  private async refreshObject(objectName: string): Promise<void> {
    const fullDef = await this.metadataStore.getFullObjectDefinition(objectName);
    if (fullDef) this.registry.registerObject(fullDef);
  }

  // =========================================================================
  // Query Helpers
  // =========================================================================

  /**
   * Lists all data objects.
   */
  listObjects(): DataObjectDefinition[] {
    return this.registry.listObjects();
  }

  /**
   * Gets a single data object definition by name.
   */
  getObject(name: string): DataObjectDefinition | undefined {
    return this.registry.getObject(name);
  }

  /**
   * Previews a change set without executing it.
   * Useful for the admin console to show users what will happen.
   */
  async previewChanges(changes: SchemaChange[]): Promise<ChangePreview> {
    const changeSet = this.buildChangeSet('Preview', changes);
    return this.validator.validateChangeSet(changeSet);
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private buildChangeSet(description: string, changes: SchemaChange[]): ChangeSet {
    return {
      id: nanoid(),
      description,
      changes,
      createdAt: new Date(),
    };
  }
}

/**
 * Whether a field modification requires dropping and re-creating the column's
 * CHECK constraints: the constraints themselves change, or the type/name
 * changes while constraints exist (a length check would block an ALTER TYPE to
 * a number; constraint names embed the column name).
 */
function constraintSyncNeeded(field: FieldDefinition, updates: FieldModification): boolean {
  const typeChanging = updates.columnType !== undefined && updates.columnType !== field.columnType;
  const renaming = updates.name !== undefined && updates.name !== field.name;
  const constraintsChanging = updates.constraints !== undefined;
  return constraintsChanging || ((typeChanging || renaming) && field.constraints !== undefined);
}

/** `contact_email` → `Contact Email` (display names for adopted structure). */
function titleCase(identifier: string): string {
  return identifier
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
