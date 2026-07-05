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
 * 4. Record the migration for history/rollback
 */

import type { Kysely } from 'kysely';
import { nanoid } from 'nanoid';
import type { SystemDatabase } from '../db/types.js';
import { ChangeValidator } from './change-validator.js';
import { DdlExecutor } from './ddl-executor.js';
import { MetadataStore } from './metadata-store.js';
import { SchemaRegistry } from './schema-registry.js';
import { bootstrapSystemTables } from './system-tables.js';
import { SYSTEM_FIELDS } from './types.js';
import type {
  ChangePreview,
  ChangeSet,
  DataObjectDefinition,
  FieldDefinition,
  RelationshipDefinition,
  SchemaChange,
} from './types.js';

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
   * Removes a field (column) from a data object.
   */
  async removeField(
    objectName: string,
    fieldName: string,
  ): Promise<{
    preview: ChangePreview;
    success: boolean;
  }> {
    const changeSet = this.buildChangeSet(`Remove field "${fieldName}" from "${objectName}"`, [
      {
        type: 'remove_field',
        objectName,
        details: { fieldName },
      },
    ]);

    const preview = await this.validator.validateChangeSet(changeSet);
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
    }

    // Record relationship metadata
    await this.metadataStore.createRelationship(
      relationship,
      sourceMetaObj.id,
      targetMetaObj.id,
      sourceFieldId,
    );

    // Record migration
    const version = (await this.metadataStore.getLatestMigrationVersion()) + 1;
    await this.metadataStore.recordMigration({
      version,
      description: `Add ${relationship.type} relationship "${relationship.name}"`,
      changes: { type: 'add_relationship', relationship: relationship.name },
      sqlUp: `-- Relationship: ${relationship.name}`,
    });

    // Update cache
    this.registry.addRelationship(relationship);

    return { preview, success: true };
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
