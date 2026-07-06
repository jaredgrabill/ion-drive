/**
 * Schema drift doctor (Phase 10 / ADR-017 rule 3): diffs the live PostgreSQL
 * catalog (`information_schema`) against Ion Drive's metadata
 * (`_ion_objects`/`_ion_fields`) and *reports* — it never auto-fixes.
 *
 * Findings:
 * - `unmanaged_table`  — a table in the DB that no object describes
 * - `unmanaged_column` — a column on a managed table that no field describes
 * - `missing_table`    — metadata describes an object whose table is gone
 * - `missing_column`   — metadata describes a field whose column is gone
 * - `type_mismatch`    — the column's PG type family disagrees with metadata
 *
 * Each unmanaged finding carries an inferred friendly type so the caller can
 * offer an **adopt** action (import into metadata); findings can also be
 * **ignored** via a persisted allowlist (`_ion_config` key
 * `schema_doctor_ignores`, entries `"table"` or `"table.column"`).
 *
 * Provenance escalates severity (ADR-017): drift touching a block-managed
 * object is reported as `critical` — manual SQL on a block's tables can break
 * the block's contract.
 */

import { type Kysely, sql } from 'kysely';
import type { ConfigStore } from '../config/config-store.js';
import type { TenantDatabase } from '../db/types.js';
import type { SchemaRegistry } from './schema-registry.js';
import {
  COLUMN_TYPES,
  type ColumnTypeName,
  type DataObjectDefinition,
  managedByBlock,
} from './types.js';

export const DOCTOR_IGNORES_KEY = 'schema_doctor_ignores';

export type DoctorFindingKind =
  | 'unmanaged_table'
  | 'unmanaged_column'
  | 'missing_table'
  | 'missing_column'
  | 'type_mismatch';

export interface DoctorFinding {
  kind: DoctorFindingKind;
  severity: 'info' | 'warning' | 'critical';
  table: string;
  column?: string;
  /** Managed object name, when the finding concerns a known object. */
  objectName?: string;
  detail: string;
  /** For adoptable findings — the inferred Ion Drive column type. */
  suggestedType?: ColumnTypeName;
  /** Allowlist key that would silence this finding. */
  ignoreKey: string;
}

export interface DoctorReport {
  healthy: boolean;
  findings: DoctorFinding[];
  ignored: string[];
  checkedAt: string;
}

interface CatalogColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  is_nullable: string;
}

export interface SchemaDoctorOptions {
  tenantDb: Kysely<TenantDatabase>;
  registry: SchemaRegistry;
  configStore?: ConfigStore;
  /**
   * Tables owned by platform infrastructure (e.g. the auth provider's user /
   * session tables — see `AuthProvider.getManagedTables()`). They live in the
   * same database but are not Ion objects, so the doctor skips them instead of
   * reporting them as unmanaged drift. `_ion_*` tables are always skipped.
   */
  systemTables?: string[];
}

export class SchemaDoctor {
  private readonly systemTables: Set<string>;

  constructor(private readonly options: SchemaDoctorOptions) {
    this.systemTables = new Set(options.systemTables ?? []);
  }

  /** Runs the full diagnosis. */
  async diagnose(): Promise<DoctorReport> {
    const { registry } = this.options;
    const ignores = await this.getIgnores();
    const catalog = await this.loadCatalog();
    const findings: DoctorFinding[] = [];

    const objects = registry.listObjects();
    const managedTables = new Map(objects.map((o) => [o.tableName, o]));
    const junctionTables = new Set(
      objects.flatMap((o) =>
        (o.relationships ?? []).flatMap((r) => (r.junctionTable ? [r.junctionTable] : [])),
      ),
    );

    // --- DB → metadata: unmanaged tables/columns, type mismatches ---
    const tables = groupByTable(catalog);

    for (const [tableName, columns] of tables) {
      if (tableName.startsWith('_ion_') || this.systemTables.has(tableName)) continue;
      if (junctionTables.has(tableName)) continue;

      const obj = managedTables.get(tableName);
      if (!obj) {
        findings.push({
          kind: 'unmanaged_table',
          severity: 'warning',
          table: tableName,
          detail: `Table "${tableName}" exists in the database but is not a managed data object. Adopt it to expose it through the API, or ignore it.`,
          ignoreKey: tableName,
        });
        continue;
      }

      findings.push(...checkManagedTable(obj, tableName, columns));
    }

    // --- metadata → DB: missing tables/columns ---
    for (const obj of objects) {
      findings.push(...checkObjectPresence(obj, tables));
    }

    const visible = findings.filter((f) => !ignores.includes(f.ignoreKey));
    return {
      healthy: visible.length === 0,
      findings: visible,
      ignored: ignores,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Adds an allowlist entry so a finding stops being reported. */
  async ignore(key: string): Promise<string[]> {
    const ignores = await this.getIgnores();
    if (!ignores.includes(key)) ignores.push(key);
    await this.options.configStore?.set(
      DOCTOR_IGNORES_KEY,
      ignores,
      'Schema doctor findings the operator chose to ignore',
    );
    return ignores;
  }

  /** Removes an allowlist entry. */
  async unignore(key: string): Promise<string[]> {
    const ignores = (await this.getIgnores()).filter((k) => k !== key);
    await this.options.configStore?.set(
      DOCTOR_IGNORES_KEY,
      ignores,
      'Schema doctor findings the operator chose to ignore',
    );
    return ignores;
  }

  /** Loads the column catalog of the public schema. */
  private async loadCatalog(): Promise<CatalogColumn[]> {
    const result = await sql<CatalogColumn>`
      SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
             c.character_maximum_length, c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position
    `.execute(this.options.tenantDb);
    return result.rows;
  }

  private async getIgnores(): Promise<string[]> {
    const stored = await this.options.configStore?.get<string[]>(DOCTOR_IGNORES_KEY);
    return Array.isArray(stored) ? [...stored] : [];
  }
}

// ---------------------------------------------------------------------------
// Diagnosis helpers
// ---------------------------------------------------------------------------

/** Groups the flat catalog rows by table name, preserving column order. */
function groupByTable(catalog: CatalogColumn[]): Map<string, CatalogColumn[]> {
  const tables = new Map<string, CatalogColumn[]>();
  for (const col of catalog) {
    const list = tables.get(col.table_name) ?? [];
    list.push(col);
    tables.set(col.table_name, list);
  }
  return tables;
}

/**
 * DB → metadata checks for one managed table: reports columns no field
 * describes (`unmanaged_column`) and PG-family disagreements (`type_mismatch`).
 * Block-owned drift escalates to critical (ADR-017).
 */
function checkManagedTable(
  obj: DataObjectDefinition,
  tableName: string,
  columns: CatalogColumn[],
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const fieldsByColumn = new Map(obj.fields.map((f) => [f.columnName, f]));
  const blockOwner = managedByBlock(obj.managedBy);

  for (const col of columns) {
    const field = fieldsByColumn.get(col.column_name);
    if (!field) {
      findings.push(unmanagedColumnFinding(obj, tableName, col, blockOwner));
      continue;
    }
    const mismatch = typeMismatch(field.columnType, col);
    if (mismatch) {
      const owner = managedByBlock(field.managedBy) ?? blockOwner;
      findings.push(typeMismatchFinding(obj, tableName, col, field, mismatch, owner));
    }
  }
  return findings;
}

/** Builds the finding for a column no field describes. */
function unmanagedColumnFinding(
  obj: DataObjectDefinition,
  tableName: string,
  col: CatalogColumn,
  blockOwner: string | null,
): DoctorFinding {
  return {
    kind: 'unmanaged_column',
    severity: blockOwner ? 'critical' : 'warning',
    table: tableName,
    column: col.column_name,
    objectName: obj.name,
    detail: blockOwner
      ? `Column "${col.column_name}" on "${tableName}" is not described by any field — this table is managed by the "${blockOwner}" block, so unmanaged drift may break it.`
      : `Column "${col.column_name}" on "${tableName}" is not described by any field. Adopt it to expose it through the API.`,
    suggestedType: inferColumnType(col),
    ignoreKey: `${tableName}.${col.column_name}`,
  };
}

/** Builds the finding for a column whose PG type family disagrees with metadata. */
function typeMismatchFinding(
  obj: DataObjectDefinition,
  tableName: string,
  col: CatalogColumn,
  field: DataObjectDefinition['fields'][number],
  mismatch: { expected: string; actual: string },
  owner: string | null,
): DoctorFinding {
  const blockNote = owner
    ? ` This field is managed by the "${owner}" block — the mismatch may break it.`
    : '';
  return {
    kind: 'type_mismatch',
    severity: owner ? 'critical' : 'warning',
    table: tableName,
    column: col.column_name,
    objectName: obj.name,
    detail: `Column "${col.column_name}" on "${tableName}" is ${mismatch.actual} in the database but the field "${field.name}" is declared as ${field.columnType} (${mismatch.expected}).${blockNote}`,
    ignoreKey: `${tableName}.${col.column_name}`,
  };
}

/**
 * metadata → DB checks for one registered object: reports a missing table, or
 * (when the table exists) fields whose columns are gone. Both are critical —
 * API calls against them fail.
 */
function checkObjectPresence(
  obj: DataObjectDefinition,
  tables: Map<string, CatalogColumn[]>,
): DoctorFinding[] {
  const columns = tables.get(obj.tableName);
  if (!columns) {
    return [
      {
        kind: 'missing_table',
        severity: 'critical',
        table: obj.tableName,
        objectName: obj.name,
        detail: `Object "${obj.name}" is registered but its table "${obj.tableName}" does not exist. API calls against it will fail.`,
        ignoreKey: obj.tableName,
      },
    ];
  }

  const findings: DoctorFinding[] = [];
  const present = new Set(columns.map((c) => c.column_name));
  for (const field of obj.fields) {
    if (!present.has(field.columnName)) {
      findings.push({
        kind: 'missing_column',
        severity: 'critical',
        table: obj.tableName,
        column: field.columnName,
        objectName: obj.name,
        detail: `Field "${field.name}" on "${obj.name}" is registered but column "${field.columnName}" does not exist in the database.`,
        ignoreKey: `${obj.tableName}.${field.columnName}`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Type inference & comparison
// ---------------------------------------------------------------------------

/** Infers the friendliest Ion Drive type for a raw catalog column (for adopt). */
export function inferColumnType(col: {
  data_type: string;
  udt_name: string;
  character_maximum_length?: number | null;
}): ColumnTypeName {
  switch (col.data_type) {
    case 'character varying':
      return col.character_maximum_length != null && col.character_maximum_length <= 255
        ? 'short_text'
        : 'text';
    case 'text':
      return 'text';
    case 'integer':
      return 'integer';
    case 'bigint':
      return 'big_integer';
    case 'smallint':
      return 'rating';
    case 'numeric':
      return 'decimal';
    case 'double precision':
    case 'real':
      return 'float';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'time without time zone':
    case 'time with time zone':
      return 'time';
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return 'datetime';
    case 'uuid':
      return 'uuid';
    case 'jsonb':
    case 'json':
      return 'json';
    case 'inet':
      return 'ip_address';
    case 'ARRAY':
      return col.udt_name === '_int4' ? 'array_integer' : 'array_text';
    default:
      return 'text';
  }
}

/**
 * Compares a field's declared type against the actual catalog column, at the
 * *family* level (VARCHAR(255) vs VARCHAR(320) is not drift; TEXT vs INTEGER
 * is). Returns the mismatching pair or null.
 */
function typeMismatch(
  declared: ColumnTypeName,
  col: CatalogColumn,
): { expected: string; actual: string } | null {
  const expected = pgFamily(COLUMN_TYPES[declared]?.pg ?? 'TEXT');
  const actual = catalogFamily(col);
  if (expected === actual) return null;
  return { expected, actual };
}

/** Exact-match declared PG types → family (parameterised types are handled by prefix). */
const PG_FAMILY_EXACT: Record<string, string> = {
  TEXT: 'text',
  INTEGER: 'integer',
  SERIAL: 'integer',
  BIGINT: 'bigint',
  SMALLINT: 'smallint',
  'DOUBLE PRECISION': 'float',
  REAL: 'float',
  BOOLEAN: 'boolean',
  DATE: 'date',
  TIME: 'time',
  UUID: 'uuid',
  JSONB: 'json',
  JSON: 'json',
  INET: 'inet',
};

function pgFamily(pg: string): string {
  const upper = pg.toUpperCase();
  if (upper.startsWith('VARCHAR')) return 'text';
  if (upper.startsWith('NUMERIC')) return 'numeric';
  if (upper.startsWith('TIMESTAMP')) return 'timestamp';
  const exact = PG_FAMILY_EXACT[upper];
  if (exact) return exact;
  if (upper.endsWith('[]')) return 'array';
  return upper.toLowerCase();
}

function catalogFamily(col: CatalogColumn): string {
  switch (col.data_type) {
    case 'character varying':
    case 'text':
      return 'text';
    case 'integer':
      return 'integer';
    case 'bigint':
      return 'bigint';
    case 'smallint':
      return 'smallint';
    case 'numeric':
      return 'numeric';
    case 'double precision':
    case 'real':
      return 'float';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return 'timestamp';
    case 'time without time zone':
    case 'time with time zone':
      return 'time';
    case 'uuid':
      return 'uuid';
    case 'jsonb':
    case 'json':
      return 'json';
    case 'inet':
      return 'inet';
    case 'ARRAY':
      return 'array';
    default:
      return col.data_type;
  }
}
