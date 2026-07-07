/**
 * Metadata Store — CRUD operations for Ion Drive schema metadata.
 *
 * This module reads and writes data object definitions, field definitions,
 * and relationship definitions to Ion Drive's system tables. It is the
 * single source of truth for what data objects exist and how they're structured.
 *
 * The Metadata Store does NOT execute DDL — that's the DDL Executor's job.
 * This separation ensures we can validate, preview, and record changes
 * before they touch the actual database schema.
 */

import type { Kysely } from 'kysely';
import type {
  IonField,
  IonIndex,
  IonObject,
  IonRelationship,
  SystemDatabase,
} from '../db/types.js';
import { currentActorId } from '../runtime/request-context.js';
import type { DataObjectDefinition, FieldDefinition, RelationshipDefinition } from './types.js';

/**
 * Scalar FieldDefinition properties `updateField` copies verbatim, keyed by
 * property name → `_ion_fields` column. JSON bags (constraints, uiOptions)
 * are handled separately because they serialize on write.
 */
const FIELD_UPDATE_COLUMNS = {
  name: 'name',
  columnName: 'column_name',
  columnType: 'column_type',
  displayName: 'display_name',
  isRequired: 'is_required',
  isUnique: 'is_unique',
  isIndexed: 'is_indexed',
  defaultValue: 'default_value',
  sortOrder: 'sort_order',
  description: 'description',
  managedBy: 'managed_by',
} as const;

export class MetadataStore {
  constructor(private readonly db: Kysely<SystemDatabase>) {}

  // -------------------------------------------------------------------------
  // Data Objects
  // -------------------------------------------------------------------------

  async listObjects(): Promise<IonObject[]> {
    return this.db.selectFrom('_ion_objects').selectAll().orderBy('name', 'asc').execute();
  }

  async getObject(name: string): Promise<IonObject | undefined> {
    return this.db
      .selectFrom('_ion_objects')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();
  }

  async getObjectById(id: string): Promise<IonObject | undefined> {
    return this.db.selectFrom('_ion_objects').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async createObject(definition: DataObjectDefinition): Promise<IonObject> {
    const result = await this.db
      .insertInto('_ion_objects')
      .values({
        name: definition.name,
        display_name: definition.displayName,
        description: definition.description ?? null,
        table_name: definition.tableName,
        is_system: definition.isSystem ?? false,
        managed_by: definition.managedBy ?? 'user',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  async updateObject(name: string, updates: Partial<DataObjectDefinition>): Promise<IonObject> {
    const values: Record<string, unknown> = { updated_at: new Date() };
    if (updates.displayName !== undefined) values.display_name = updates.displayName;
    if (updates.description !== undefined) values.description = updates.description;

    const result = await this.db
      .updateTable('_ion_objects')
      .set(values)
      .where('name', '=', name)
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  async deleteObject(name: string): Promise<void> {
    await this.db.deleteFrom('_ion_objects').where('name', '=', name).execute();
  }

  // -------------------------------------------------------------------------
  // Fields
  // -------------------------------------------------------------------------

  async getFields(objectId: string): Promise<IonField[]> {
    return this.db
      .selectFrom('_ion_fields')
      .selectAll()
      .where('object_id', '=', objectId)
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  async getField(objectId: string, fieldName: string): Promise<IonField | undefined> {
    return this.db
      .selectFrom('_ion_fields')
      .selectAll()
      .where('object_id', '=', objectId)
      .where('name', '=', fieldName)
      .executeTakeFirst();
  }

  async createField(objectId: string, field: FieldDefinition): Promise<IonField> {
    return this.db
      .insertInto('_ion_fields')
      .values(this.fieldInsertValues(objectId, field))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async createFields(objectId: string, fields: FieldDefinition[]): Promise<IonField[]> {
    if (fields.length === 0) return [];

    return this.db
      .insertInto('_ion_fields')
      .values(fields.map((field) => this.fieldInsertValues(objectId, field)))
      .returningAll()
      .execute();
  }

  private fieldInsertValues(objectId: string, field: FieldDefinition) {
    return {
      object_id: objectId,
      name: field.name,
      display_name: field.displayName,
      column_name: field.columnName,
      column_type: field.columnType,
      is_required: field.isRequired ?? false,
      is_unique: field.isUnique ?? false,
      is_indexed: field.isIndexed ?? false,
      is_primary: field.isPrimary ?? false,
      is_system: field.isSystem ?? false,
      default_value: field.defaultValue ?? null,
      constraints: field.constraints ? JSON.stringify(field.constraints) : null,
      sort_order: field.sortOrder ?? 0,
      description: field.description ?? null,
      ui_options: field.uiOptions ? JSON.stringify(field.uiOptions) : null,
      managed_by: field.managedBy ?? 'user',
    };
  }

  async updateField(
    fieldId: string,
    updates: Omit<Partial<FieldDefinition>, 'constraints'> & {
      /** Pass null to clear stored constraints. */
      constraints?: FieldDefinition['constraints'] | null;
    },
  ): Promise<IonField> {
    const values: Record<string, unknown> = { updated_at: new Date() };

    // Scalar properties copy straight through to their snake_case column.
    for (const [prop, column] of Object.entries(FIELD_UPDATE_COLUMNS)) {
      const value = updates[prop as keyof typeof FIELD_UPDATE_COLUMNS];
      if (value !== undefined) values[column] = value;
    }
    // JSON-bag properties serialize on the way in; null clears the column.
    if (updates.constraints !== undefined) {
      values.constraints = updates.constraints ? JSON.stringify(updates.constraints) : null;
    }
    if (updates.uiOptions !== undefined) {
      values.ui_options = updates.uiOptions ? JSON.stringify(updates.uiOptions) : null;
    }

    return this.db
      .updateTable('_ion_fields')
      .set(values)
      .where('id', '=', fieldId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async deleteField(fieldId: string): Promise<void> {
    await this.db.deleteFrom('_ion_fields').where('id', '=', fieldId).execute();
  }

  // -------------------------------------------------------------------------
  // Relationships
  // -------------------------------------------------------------------------

  async getRelationships(objectId: string): Promise<IonRelationship[]> {
    return this.db
      .selectFrom('_ion_relationships')
      .selectAll()
      .where((eb) =>
        eb.or([eb('source_object_id', '=', objectId), eb('target_object_id', '=', objectId)]),
      )
      .execute();
  }

  async getAllRelationships(): Promise<IonRelationship[]> {
    return this.db.selectFrom('_ion_relationships').selectAll().execute();
  }

  async createRelationship(
    rel: RelationshipDefinition,
    sourceObjectId: string,
    targetObjectId: string,
    sourceFieldId?: string,
    targetFieldId?: string,
    junction?: { table: string; sourceColumn: string; targetColumn: string },
  ): Promise<IonRelationship> {
    return this.db
      .insertInto('_ion_relationships')
      .values({
        name: rel.name,
        display_name: rel.displayName,
        type: rel.type,
        source_object_id: sourceObjectId,
        target_object_id: targetObjectId,
        source_field_id: sourceFieldId ?? null,
        target_field_id: targetFieldId ?? null,
        junction_table: junction?.table ?? null,
        junction_source_column: junction?.sourceColumn ?? null,
        junction_target_column: junction?.targetColumn ?? null,
        cascade_delete: rel.cascadeDelete ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async deleteRelationship(relationshipId: string): Promise<void> {
    await this.db.deleteFrom('_ion_relationships').where('id', '=', relationshipId).execute();
  }

  // -------------------------------------------------------------------------
  // Indexes
  // -------------------------------------------------------------------------

  async getIndexes(objectId: string): Promise<IonIndex[]> {
    return this.db
      .selectFrom('_ion_indexes')
      .selectAll()
      .where('object_id', '=', objectId)
      .execute();
  }

  async createIndex(
    objectId: string,
    index: {
      name: string;
      indexName: string;
      columns: string[];
      isUnique?: boolean;
      isAuto?: boolean;
    },
  ): Promise<IonIndex> {
    return this.db
      .insertInto('_ion_indexes')
      .values({
        object_id: objectId,
        name: index.name,
        index_name: index.indexName,
        columns: JSON.stringify(index.columns) as unknown as string,
        is_unique: index.isUnique ?? false,
        is_auto: index.isAuto ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async deleteIndex(indexId: string): Promise<void> {
    await this.db.deleteFrom('_ion_indexes').where('id', '=', indexId).execute();
  }

  // -------------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------------

  async getLatestMigrationVersion(): Promise<number> {
    const result = await this.db
      .selectFrom('_ion_migrations')
      .select(this.db.fn.max('version').as('max_version'))
      .executeTakeFirst();

    return (result?.max_version as number | null) ?? 0;
  }

  /**
   * Appends one entry to the `_ion_migrations` audit trail. `sqlDown` is
   * **advisory documentation only** — there is deliberately no automated
   * rollback API (decided Phase 13 / ADR-020): a trustworthy rollback would
   * need the full data-loss-guard pipeline, and the platform's actual
   * recovery paths are declarative (snapshot pull/diff/push) plus database
   * backups/PITR for disasters.
   */
  async recordMigration(migration: {
    version: number;
    description?: string;
    changes: Record<string, unknown>;
    sqlUp: string;
    sqlDown?: string;
    appliedBy?: string;
  }): Promise<void> {
    await this.db
      .insertInto('_ion_migrations')
      .values({
        version: migration.version,
        description: migration.description ?? null,
        changes: JSON.stringify(migration.changes),
        sql_up: migration.sqlUp,
        sql_down: migration.sqlDown ?? null,
        // Fall back to the ambient request actor (Phase 12 / ADR-019), so every
        // schema-manager call site records provenance without threading it.
        applied_by: migration.appliedBy ?? currentActorId(),
      })
      .execute();
  }

  // -------------------------------------------------------------------------
  // Full Object Hydration
  // -------------------------------------------------------------------------

  /**
   * Loads a complete DataObjectDefinition including all fields and relationships.
   * This is the method used by the Schema Registry to build the in-memory cache.
   */
  async getFullObjectDefinition(name: string): Promise<DataObjectDefinition | null> {
    const obj = await this.getObject(name);
    if (!obj) return null;

    const fields = await this.getFields(obj.id);
    const relationships = await this.getRelationships(obj.id);

    // We need to resolve object names for relationships
    const objectMap = new Map<string, IonObject>();
    for (const rel of relationships) {
      if (!objectMap.has(rel.source_object_id)) {
        const o = await this.getObjectById(rel.source_object_id);
        if (o) objectMap.set(o.id, o);
      }
      if (!objectMap.has(rel.target_object_id)) {
        const o = await this.getObjectById(rel.target_object_id);
        if (o) objectMap.set(o.id, o);
      }
    }

    return {
      id: obj.id,
      name: obj.name,
      displayName: obj.display_name,
      description: obj.description ?? undefined,
      tableName: obj.table_name,
      isSystem: obj.is_system,
      managedBy: obj.managed_by as DataObjectDefinition['managedBy'],
      fields: fields.map((f) => ({
        id: f.id,
        name: f.name,
        displayName: f.display_name,
        columnName: f.column_name,
        columnType: f.column_type as FieldDefinition['columnType'],
        isRequired: f.is_required,
        isUnique: f.is_unique,
        isIndexed: f.is_indexed,
        isPrimary: f.is_primary,
        isSystem: f.is_system,
        defaultValue: f.default_value,
        constraints: f.constraints as FieldDefinition['constraints'],
        sortOrder: f.sort_order,
        description: f.description,
        uiOptions: f.ui_options,
        managedBy: f.managed_by as FieldDefinition['managedBy'],
      })),
      relationships: relationships.map((r) => ({
        id: r.id,
        name: r.name,
        displayName: r.display_name,
        type: r.type as RelationshipDefinition['type'],
        sourceObjectName: objectMap.get(r.source_object_id)?.name ?? '',
        targetObjectName: objectMap.get(r.target_object_id)?.name ?? '',
        sourceFieldName: r.source_field_id
          ? fields.find((f) => f.id === r.source_field_id)?.name
          : undefined,
        cascadeDelete: r.cascade_delete,
        junctionTable: r.junction_table ?? undefined,
        junctionSourceColumn: r.junction_source_column ?? undefined,
        junctionTargetColumn: r.junction_target_column ?? undefined,
      })),
    };
  }

  /**
   * Loads all object definitions. Used during startup to populate the Schema Registry.
   */
  async getAllObjectDefinitions(): Promise<DataObjectDefinition[]> {
    const objects = await this.listObjects();
    const definitions: DataObjectDefinition[] = [];

    for (const obj of objects) {
      const def = await this.getFullObjectDefinition(obj.name);
      if (def) definitions.push(def);
    }

    return definitions;
  }
}
