/**
 * System table bootstrap for Ion Drive.
 *
 * Creates the internal metadata tables that Ion Drive uses to track
 * data object definitions, fields, relationships, migrations, and indexes.
 * These tables are the source of truth for the runtime schema state.
 */

import type { Kysely } from 'kysely';
import type { SystemDatabase } from '../db/types.js';

/**
 * Bootstraps all Ion Drive system tables if they don't already exist.
 * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
 */
export async function bootstrapSystemTables(db: Kysely<SystemDatabase>): Promise<void> {
  // Ensure uuid-ossp extension is available for gen_random_uuid()
  await db.schema
    .createTable('_ion_objects')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('name', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('table_name', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('is_system', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  await db.schema
    .createTable('_ion_fields')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('object_id', 'uuid', (col) =>
      col.notNull().references('_ion_objects.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('column_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('column_type', 'varchar(50)', (col) => col.notNull())
    .addColumn('is_required', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_unique', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_indexed', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_primary', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_system', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('default_value', 'text')
    .addColumn('constraints', 'jsonb')
    .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  // Unique constraint on (object_id, name) for fields
  await db.schema
    .createIndex('_ion_fields_object_name_unique')
    .ifNotExists()
    .on('_ion_fields')
    .columns(['object_id', 'name'])
    .unique()
    .execute();

  await db.schema
    .createTable('_ion_relationships')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('type', 'varchar(20)', (col) => col.notNull())
    .addColumn('source_object_id', 'uuid', (col) =>
      col.notNull().references('_ion_objects.id').onDelete('cascade'),
    )
    .addColumn('target_object_id', 'uuid', (col) =>
      col.notNull().references('_ion_objects.id').onDelete('cascade'),
    )
    .addColumn('source_field_id', 'uuid', (col) =>
      col.references('_ion_fields.id').onDelete('set null'),
    )
    .addColumn('target_field_id', 'uuid', (col) =>
      col.references('_ion_fields.id').onDelete('set null'),
    )
    .addColumn('junction_table', 'varchar(255)')
    .addColumn('junction_source_column', 'varchar(255)')
    .addColumn('junction_target_column', 'varchar(255)')
    .addColumn('cascade_delete', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  await db.schema
    .createTable('_ion_migrations')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('changes', 'jsonb', (col) => col.notNull())
    .addColumn('sql_up', 'text', (col) => col.notNull())
    .addColumn('sql_down', 'text')
    .addColumn('applied_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('applied_by', 'varchar(255)')
    .execute();

  await db.schema
    .createTable('_ion_indexes')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('object_id', 'uuid', (col) =>
      col.notNull().references('_ion_objects.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('index_name', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('columns', 'jsonb', (col) => col.notNull())
    .addColumn('is_unique', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_auto', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();
}

/**
 * Checks if the system tables have been bootstrapped.
 */
export async function isBootstrapped(db: Kysely<SystemDatabase>): Promise<boolean> {
  try {
    await db.selectFrom('_ion_objects').select('id').limit(1).execute();
    return true;
  } catch {
    return false;
  }
}
