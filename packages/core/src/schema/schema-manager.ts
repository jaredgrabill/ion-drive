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
  RelationshipDefinition,
  SchemaChange,
} from './types.js';

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
   */
  async initialize(): Promise<void> {
    await bootstrapSystemTables(this.systemDb);
    await this.registry.loadFromStore(this.metadataStore);
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

    // Execute
    const sqlStatements = await this.ddlExecutor.createTable(definition);

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

    // Execute DDL
    const sqlStatements = await this.ddlExecutor.dropTable(obj.tableName);

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
    const typeChanging =
      updates.columnType !== undefined && updates.columnType !== field.columnType;
    const renaming = updates.name !== undefined && updates.name !== field.name;
    const constraintsChanging = updates.constraints !== undefined;
    const needsConstraintSync =
      constraintsChanging || ((typeChanging || renaming) && field.constraints !== undefined);
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

    // Rename last so every step above operated on the original column name.
    if (updates.name !== undefined && updates.name !== field.name) {
      executed.push(...(await ddlExecutor.renameColumn(table, column, updates.name)));
    }

    // Re-create CHECK constraints against the final column name/type/rules.
    if (needsConstraintSync) {
      const effectiveConstraints =
        updates.constraints === null ? undefined : (updates.constraints ?? field.constraints);
      if (effectiveConstraints) {
        executed.push(
          ...(await ddlExecutor.addCheckConstraints(table, {
            ...field,
            columnName: updates.name ?? column,
            columnType: updates.columnType ?? field.columnType,
            constraints: effectiveConstraints,
          })),
        );
      }
    }

    return executed;
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
      // Create FK column on the "many" side (or source for one_to_one)
      const fkTable =
        relationship.type === 'one_to_many' ? targetObj.tableName : sourceObj.tableName;
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
      if (fkMetaObj) {
        const fieldRecord = await this.metadataStore.createField(fkMetaObj.id, fkField);
        sourceFieldId = fieldRecord.id;
      }
    } else if (relationship.type === 'many_to_many') {
      // Create junction table
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

/** `contact_email` → `Contact Email` (display names for adopted structure). */
function titleCase(identifier: string): string {
  return identifier
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
