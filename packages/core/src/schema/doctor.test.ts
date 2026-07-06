/**
 * Unit tests for the schema drift doctor's system-table handling: tables owned
 * by platform infrastructure (the auth provider's tables, `_ion_*` tables) must
 * not be reported as unmanaged drift, while genuinely unknown tables must be.
 */

import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { BETTER_AUTH_TABLES, BetterAuthProvider } from '../auth/better-auth-adapter.js';
import type { TenantDatabase } from '../db/types.js';
import { SchemaDoctor } from './doctor.js';
import type { SchemaRegistry } from './schema-registry.js';

/** Minimal `information_schema.columns` row as loaded by the doctor. */
interface CatalogRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  is_nullable: string;
}

function row(tableName: string, columnName = 'id'): CatalogRow {
  return {
    table_name: tableName,
    column_name: columnName,
    data_type: 'uuid',
    udt_name: 'uuid',
    character_maximum_length: null,
    is_nullable: 'NO',
  };
}

/** Builds a doctor over a fake catalog, with no managed objects registered. */
function makeDoctor(catalog: CatalogRow[], systemTables?: string[]): SchemaDoctor {
  const registry = { listObjects: () => [] } as unknown as SchemaRegistry;
  const doctor = new SchemaDoctor({
    tenantDb: {} as Kysely<TenantDatabase>,
    registry,
    systemTables,
  });
  // Stub the private information_schema query — unit tests have no Postgres.
  (doctor as unknown as { loadCatalog: () => Promise<CatalogRow[]> }).loadCatalog = async () =>
    catalog;
  return doctor;
}

describe('SchemaDoctor system tables', () => {
  it('reports an unknown table as unmanaged when no system tables are declared', async () => {
    const report = await makeDoctor([row('mystery')]).diagnose();
    expect(report.healthy).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: 'unmanaged_table', table: 'mystery' });
  });

  it('does not report provider-supplied tables as unmanaged', async () => {
    const catalog = [row('custom_auth_users'), row('custom_auth_sessions')];
    const doctor = makeDoctor(catalog, ['custom_auth_users', 'custom_auth_sessions']);
    const report = await doctor.diagnose();
    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('skips Better Auth tables when wired from BETTER_AUTH_TABLES, but not others', async () => {
    const catalog = [...BETTER_AUTH_TABLES.map((t) => row(t)), row('_ion_objects'), row('orders')];
    const doctor = makeDoctor(catalog, [...BETTER_AUTH_TABLES]);
    const report = await doctor.diagnose();
    // Only the genuinely unmanaged table surfaces; auth + _ion_* are skipped.
    expect(report.findings.map((f) => f.table)).toEqual(['orders']);
  });

  it('exposes the Better Auth table list via getManagedTables()', () => {
    // Constructing the provider requires a live pg pool, so exercise the
    // method against the prototype — it only reads the module constant.
    const tables = BetterAuthProvider.prototype.getManagedTables.call(undefined);
    expect(tables).toEqual([...BETTER_AUTH_TABLES]);
    expect(tables).toContain('user');
    expect(tables).toContain('session');
  });
});
