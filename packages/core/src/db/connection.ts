/**
 * Database connection management for Ion Drive.
 *
 * Manages two types of connections:
 * 1. System database — Ion Drive's own metadata (typed via SystemDatabase interface)
 * 2. Tenant databases — User-defined data objects (dynamic, typed as `any`)
 *
 * Uses Kysely with the pg driver for PostgreSQL access.
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { SystemDatabase } from './types.js';

const { Pool } = pg;

export interface ConnectionOptions {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/**
 * Creates a typed Kysely instance for the Ion Drive system database.
 * This connection is used for all metadata operations (object definitions,
 * field definitions, relationships, migrations, etc.)
 */
export function createSystemDb(options: ConnectionOptions): Kysely<SystemDatabase> {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });

  return new Kysely<SystemDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * Creates an untyped Kysely instance for tenant data operations.
 * Since tenant schemas are defined at runtime, we use `Kysely<any>` and
 * rely on our own validation layer (SchemaRegistry + ChangeValidator)
 * to ensure query correctness.
 */
export function createTenantDb(options: ConnectionOptions): Kysely<Record<string, unknown>> {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 20,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });

  return new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * Tests a database connection by running a simple query.
 * @returns true if the connection is successful
 */
export async function testConnection(db: Kysely<unknown>): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}
