/**
 * Platform table bootstrap — config, secrets, RBAC, and API keys.
 *
 * These sit alongside the schema-engine system tables (see schema/system-tables.ts)
 * but cover Phase 4 concerns: platform configuration, encrypted secrets, role-based
 * access control, and API key authentication. Better Auth manages its own tables
 * (user/session/account/verification) via its migration runner, so they are not
 * created here.
 *
 * Safe to call repeatedly — everything uses CREATE ... IF NOT EXISTS.
 */

import type { Kysely } from 'kysely';
import type { SystemDatabase } from '../db/types.js';

export async function bootstrapPlatformTables(db: Kysely<SystemDatabase>): Promise<void> {
  // --- Configuration key/value ---
  await db.schema
    .createTable('_ion_config')
    .ifNotExists()
    .addColumn('key', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('value', 'jsonb', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  // --- Encrypted secrets ---
  await db.schema
    .createTable('_ion_secrets')
    .ifNotExists()
    .addColumn('key', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('encrypted_value', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  // --- RBAC roles ---
  await db.schema
    .createTable('_ion_roles')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('name', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('description', 'text')
    .addColumn('permissions', 'jsonb', (col) => col.notNull().defaultTo('[]'))
    .addColumn('is_system', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  // --- Role assignments (user_id references a Better Auth user; no FK) ---
  await db.schema
    .createTable('_ion_user_roles')
    .ifNotExists()
    .addColumn('user_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('role_id', 'uuid', (col) =>
      col.notNull().references('_ion_roles.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addPrimaryKeyConstraint('_ion_user_roles_pkey', ['user_id', 'role_id'])
    .execute();

  // --- API keys (hashed) ---
  await db.schema
    .createTable('_ion_api_keys')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('key_hash', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('prefix', 'varchar(32)', (col) => col.notNull())
    .addColumn('user_id', 'varchar(255)')
    .addColumn('role_id', 'uuid', (col) => col.references('_ion_roles.id').onDelete('set null'))
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('expires_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();
}
