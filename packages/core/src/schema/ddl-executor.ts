/**
 * DDL Executor — Executes Data Definition Language operations on PostgreSQL.
 *
 * This module is responsible for the actual CREATE TABLE, ALTER TABLE,
 * and DROP TABLE operations. It translates Ion Drive's domain model
 * (DataObjectDefinition, FieldDefinition) into Kysely Schema Builder
 * or raw SQL calls.
 *
 * The DDL Executor does NOT manage metadata — that's the MetadataStore's job.
 * It only touches the actual database schema.
 */

import { type Kysely, sql } from 'kysely';
import {
  type CheckConstraintSpec,
  buildCheckConstraints,
  checkConstraintPrefix,
} from './check-constraints.js';
import { COLUMN_TYPES, SYSTEM_FIELDS } from './types.js';
import type { ColumnTypeName, DataObjectDefinition, FieldDefinition } from './types.js';

/**
 * Renders a `defaultValue` into a SQL-ready DEFAULT expression.
 *
 * A default may be either a **SQL expression** (a function call like
 * `gen_random_uuid()`/`NOW()`, a keyword like `TRUE`/`NULL`, a number, or an
 * explicit cast) or a **literal value** (`lead`, `note`). Expressions are used
 * verbatim; literals are quoted as string literals — otherwise Postgres reads a
 * bare word like `lead` as a column reference ("cannot use column reference in
 * DEFAULT expression"). This lets both manifest authors and admin users write
 * natural defaults (`'lead'`, `false`) without hand-quoting.
 */
export function renderDefaultExpression(rawValue: string | null | undefined): string {
  const value = rawValue?.trim() ?? '';
  if (value === '') return "''";

  // Numbers → raw.
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;

  // Common SQL keywords / expressions → raw (function calls, casts, keywords).
  const keywords = ['true', 'false', 'null', 'current_timestamp', 'current_date', 'current_time'];
  const isExpression =
    value.endsWith(')') || // function call, e.g. NOW(), gen_random_uuid()
    value.includes('::') || // explicit cast, e.g. '{}'::jsonb
    keywords.includes(value.toLowerCase());
  if (isExpression) return value;

  // Already a quoted string literal → leave as-is.
  if (value.startsWith("'") && value.endsWith("'")) return value;

  // Otherwise treat as a literal value and quote it (escaping single quotes).
  return `'${value.replace(/'/g, "''")}'`;
}

/** Canonical name of an Ion-managed UNIQUE constraint over a column group. */
export function uniqueConstraintName(tableName: string, columns: string[]): string {
  return `ion_uq_${tableName}_${columns.join('_')}`;
}

/** Renders the ADD CONSTRAINT … UNIQUE statement (shared with previews). */
export function renderAddUniqueConstraint(tableName: string, columns: string[]): string {
  const cols = columns.map((c) => `"${c}"`).join(', ');
  return `ALTER TABLE "${tableName}" ADD CONSTRAINT "${uniqueConstraintName(tableName, columns)}" UNIQUE (${cols})`;
}

export class DdlExecutor {
  constructor(private readonly db: Kysely<Record<string, unknown>>) {}

  /**
   * Creates a new table from a data object definition.
   * Automatically includes system fields (id, created_at, updated_at).
   */
  async createTable(definition: DataObjectDefinition): Promise<string[]> {
    const allFields = [...SYSTEM_FIELDS, ...definition.fields];
    const statements: string[] = [];

    let builder = this.db.schema.createTable(definition.tableName);

    for (const field of allFields) {
      const pgType = this.resolveColumnType(field);
      builder = builder.addColumn(field.columnName, sql.raw(pgType) as never, (col) => {
        let c = col;
        if (field.isPrimary) c = c.primaryKey();
        if (field.isRequired && !field.isPrimary) c = c.notNull();
        if (field.isUnique && !field.isPrimary) c = c.unique();
        if (field.defaultValue) {
          c = c.defaultTo(sql.raw(this.renderDefault(field)));
        }
        return c;
      });
    }

    await builder.execute();
    statements.push(`CREATE TABLE "${definition.tableName}" (...)`);

    // Create auto-indexes for fields marked as indexed
    for (const field of allFields) {
      if (field.isIndexed && !field.isPrimary && !field.isUnique) {
        const indexName = `idx_${definition.tableName}_${field.columnName}`;
        await this.db.schema
          .createIndex(indexName)
          .on(definition.tableName)
          .column(field.columnName)
          .execute();
        statements.push(
          `CREATE INDEX "${indexName}" ON "${definition.tableName}" ("${field.columnName}")`,
        );
      }
    }

    // Enforce field constraints as CHECK constraints (Phase 10, ADR-017 rule 1)
    for (const field of definition.fields) {
      statements.push(...(await this.addCheckConstraints(definition.tableName, field)));
    }

    // Create updated_at trigger
    await this.createUpdatedAtTrigger(definition.tableName);
    statements.push(`CREATE TRIGGER update_updated_at ON "${definition.tableName}"`);

    return statements;
  }

  /**
   * Drops a table.
   */
  async dropTable(tableName: string): Promise<string[]> {
    await this.db.schema.dropTable(tableName).ifExists().cascade().execute();
    return [`DROP TABLE IF EXISTS "${tableName}" CASCADE`];
  }

  /**
   * Adds a column to an existing table.
   */
  async addColumn(tableName: string, field: FieldDefinition): Promise<string[]> {
    const pgType = this.resolveColumnType(field);
    const statements: string[] = [];

    await this.db.schema
      .alterTable(tableName)
      .addColumn(field.columnName, sql.raw(pgType) as never, (col) => {
        let c = col;
        if (field.isRequired) {
          // If adding a required column, we need a default for existing rows
          if (field.defaultValue) {
            c = c.notNull().defaultTo(sql.raw(this.renderDefault(field)));
          } else {
            // Use a sensible default based on type, then make it NOT NULL
            const defaultVal = this.getTypeDefault(field.columnType);
            c = c.notNull().defaultTo(sql.raw(defaultVal));
          }
        }
        if (field.isUnique) c = c.unique();
        if (field.defaultValue) c = c.defaultTo(sql.raw(this.renderDefault(field)));
        return c;
      })
      .execute();

    statements.push(`ALTER TABLE "${tableName}" ADD COLUMN "${field.columnName}" ${pgType}`);

    if (field.isIndexed) {
      const indexName = `idx_${tableName}_${field.columnName}`;
      await this.db.schema.createIndex(indexName).on(tableName).column(field.columnName).execute();
      statements.push(`CREATE INDEX "${indexName}" ON "${tableName}" ("${field.columnName}")`);
    }

    statements.push(...(await this.addCheckConstraints(tableName, field)));

    return statements;
  }

  /**
   * Adds a plain nullable column only when absent. Used by boot migrations
   * that retrofit new system columns (e.g. the Phase 12 actor columns) onto
   * pre-existing tables — `IF NOT EXISTS` makes a crash between DDL and
   * metadata recording safely re-runnable.
   */
  async addColumnIfNotExists(tableName: string, field: FieldDefinition): Promise<string> {
    const statement = `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${field.columnName}" ${this.resolveColumnType(field)}`;
    await sql.raw(statement).execute(this.db);
    return statement;
  }

  /**
   * Drops a column from an existing table.
   */
  async dropColumn(tableName: string, columnName: string): Promise<string[]> {
    await this.db.schema.alterTable(tableName).dropColumn(columnName).execute();

    return [`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`];
  }

  /**
   * Renames a column.
   */
  async renameColumn(tableName: string, oldName: string, newName: string): Promise<string[]> {
    await this.db.schema.alterTable(tableName).renameColumn(oldName, newName).execute();

    return [`ALTER TABLE "${tableName}" RENAME COLUMN "${oldName}" TO "${newName}"`];
  }

  // -------------------------------------------------------------------------
  // Column modification (Phase 10)
  // -------------------------------------------------------------------------

  /**
   * Changes a column's type. `usingCast` (e.g. `::BIGINT`) is appended as a
   * `USING` expression when the conversion has no assignment cast; when
   * omitted, Postgres applies its own coercion and errors on lossy values —
   * a deliberate backstop behind the validator's pre-checks.
   */
  async alterColumnType(
    tableName: string,
    columnName: string,
    targetPgType: string,
    usingCast?: string,
  ): Promise<string[]> {
    const using = usingCast ? ` USING "${columnName}"${usingCast}` : '';
    const statement = `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" TYPE ${targetPgType}${using}`;
    await sql.raw(statement).execute(this.db);
    return [statement];
  }

  /** Sets (or replaces) a column's DEFAULT expression. */
  async setColumnDefault(
    tableName: string,
    columnName: string,
    defaultValue: string,
  ): Promise<string[]> {
    const rendered = renderDefaultExpression(defaultValue);
    const statement = `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" SET DEFAULT ${rendered}`;
    await sql.raw(statement).execute(this.db);
    return [statement];
  }

  /** Clears a column's DEFAULT expression. */
  async dropColumnDefault(tableName: string, columnName: string): Promise<string[]> {
    const statement = `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" DROP DEFAULT`;
    await sql.raw(statement).execute(this.db);
    return [statement];
  }

  /**
   * Makes a column NOT NULL. When `backfillValue` is provided, existing NULL
   * rows are first updated to it (rendered like a DEFAULT expression) so the
   * constraint can be applied.
   */
  async setNotNull(
    tableName: string,
    columnName: string,
    backfillValue?: string,
  ): Promise<string[]> {
    const statements: string[] = [];
    if (backfillValue !== undefined) {
      const rendered = renderDefaultExpression(backfillValue);
      const update = `UPDATE "${tableName}" SET "${columnName}" = ${rendered} WHERE "${columnName}" IS NULL`;
      await sql.raw(update).execute(this.db);
      statements.push(update);
    }
    const alter = `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" SET NOT NULL`;
    await sql.raw(alter).execute(this.db);
    statements.push(alter);
    return statements;
  }

  /** Removes a column's NOT NULL constraint. */
  async dropNotNull(tableName: string, columnName: string): Promise<string[]> {
    const statement = `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" DROP NOT NULL`;
    await sql.raw(statement).execute(this.db);
    return [statement];
  }

  /**
   * Adds a named UNIQUE constraint on one column or a column group
   * (`ion_uq_<table>_<col1>[_<col2>…]`). Groups back the composite
   * `constraints.uniqueTogether` feature (issue #9) and are valid upsert
   * conflict targets.
   */
  async addUniqueConstraint(tableName: string, columns: string | string[]): Promise<string[]> {
    const cols = Array.isArray(columns) ? columns : [columns];
    const statement = renderAddUniqueConstraint(tableName, cols);
    await sql.raw(statement).execute(this.db);
    return [statement];
  }

  /** Drops a named constraint (no-op when absent). */
  async dropConstraintByName(tableName: string, constraintName: string): Promise<string[]> {
    const statement = `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${constraintName}"`;
    await sql.raw(statement).execute(this.db);
    return [statement];
  }

  /**
   * Drops the UNIQUE constraint covering exactly this column, whatever it was
   * named (inline `col.unique()` uses PG's default `<table>_<col>_key`; ours
   * use `ion_uq_*`). No-op if none exists.
   */
  async dropUniqueConstraint(tableName: string, columnName: string): Promise<string[]> {
    const name = await this.findUniqueConstraint(tableName, columnName);
    if (!name) return [];
    const statement = `ALTER TABLE "${tableName}" DROP CONSTRAINT "${name}"`;
    await sql.raw(statement).execute(this.db);
    return [statement];
  }

  /** Finds the name of a single-column UNIQUE constraint, if any. */
  async findUniqueConstraint(tableName: string, columnName: string): Promise<string | null> {
    const result = await sql<{ conname: string }>`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public'
        AND rel.relname = ${tableName}
        AND con.contype = 'u'
        AND con.conkey = (
          SELECT ARRAY[attnum]::smallint[] FROM pg_attribute
          WHERE attrelid = rel.oid AND attname = ${columnName}
        )
      LIMIT 1
    `.execute(this.db);
    return result.rows[0]?.conname ?? null;
  }

  /**
   * Finds the name of the UNIQUE constraint covering exactly this column
   * group (order-insensitive), whatever it was named. Used to drop composite
   * constraints that may predate the `ion_uq_*` naming scheme.
   */
  async findUniqueConstraintForColumns(
    tableName: string,
    columns: string[],
  ): Promise<string | null> {
    const sorted = [...columns].sort();
    const result = await sql<{ conname: string }>`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public'
        AND rel.relname = ${tableName}
        AND con.contype = 'u'
        AND (
          SELECT array_agg(att.attname::text ORDER BY att.attname)
          FROM unnest(con.conkey) AS k
          JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = k
        ) = ${sorted}::text[]
      LIMIT 1
    `.execute(this.db);
    return result.rows[0]?.conname ?? null;
  }

  /**
   * Sample of value combinations duplicated across a column group (the
   * pre-check before adding a composite UNIQUE constraint — mirrors
   * {@link findDuplicateValues} for single columns). Rows where any group
   * column is NULL are skipped, matching UNIQUE's NULLs-are-distinct
   * semantics.
   */
  async findDuplicateGroupValues(
    tableName: string,
    columns: string[],
    limit = 5,
  ): Promise<{ values: string; count: number }[]> {
    const refs = sql.join(columns.map((c) => sql.ref(c)));
    const rendered = sql.join(
      columns.map((c) => sql`${sql.ref(c)}::text`),
      sql.raw(` || ', ' || `),
    );
    const notNull = sql.join(
      columns.map((c) => sql`${sql.ref(c)} IS NOT NULL`),
      sql.raw(' AND '),
    );
    const result = await sql<{ values: string; count: string }>`
      SELECT ${rendered} AS values, COUNT(*) AS count
      FROM ${sql.table(tableName)}
      WHERE ${notNull}
      GROUP BY ${refs}
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT ${limit}
    `.execute(this.db);
    return result.rows.map((r) => ({ values: r.values, count: Number.parseInt(r.count, 10) }));
  }

  // -------------------------------------------------------------------------
  // CHECK constraints (Phase 10 — field constraints enforced in Postgres)
  // -------------------------------------------------------------------------

  /** Adds every CHECK constraint a field's constraints imply. */
  async addCheckConstraints(tableName: string, field: FieldDefinition): Promise<string[]> {
    const specs = buildCheckConstraints(
      tableName,
      field.columnName,
      field.columnType,
      field.constraints ?? undefined,
    );
    const statements: string[] = [];
    for (const spec of specs) {
      const statement = `ALTER TABLE "${tableName}" ADD CONSTRAINT "${spec.name}" CHECK (${spec.expression})`;
      await sql.raw(statement).execute(this.db);
      statements.push(statement);
    }
    return statements;
  }

  /** Drops every Ion-managed CHECK constraint on a column (by name prefix). */
  async dropCheckConstraints(tableName: string, columnName: string): Promise<string[]> {
    const prefix = checkConstraintPrefix(tableName, columnName);
    const existing = await sql<{ conname: string }>`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public'
        AND rel.relname = ${tableName}
        AND con.contype = 'c'
        AND con.conname LIKE ${`${prefix}%`}
    `.execute(this.db);

    const statements: string[] = [];
    for (const row of existing.rows) {
      const statement = `ALTER TABLE "${tableName}" DROP CONSTRAINT "${row.conname}"`;
      await sql.raw(statement).execute(this.db);
      statements.push(statement);
    }
    return statements;
  }

  /**
   * Number of existing rows that would violate a proposed CHECK expression.
   * `IS FALSE` deliberately lets NULL evaluations pass, matching CHECK
   * semantics.
   */
  async countCheckViolations(tableName: string, spec: CheckConstraintSpec): Promise<number> {
    const result = await sql<{ count: string }>`
      SELECT COUNT(*) AS count FROM ${sql.table(tableName)}
      WHERE (${sql.raw(spec.expression)}) IS FALSE
    `.execute(this.db);
    return Number.parseInt(result.rows[0]?.count ?? '0', 10);
  }

  // -------------------------------------------------------------------------
  // Data pre-checks (used by the ChangeValidator before risky modifications)
  // -------------------------------------------------------------------------

  /** Longest existing value (in characters) of a column, rendered as text. */
  async getMaxTextLength(tableName: string, columnName: string): Promise<number> {
    const result = await sql<{ max_len: number | null }>`
      SELECT MAX(CHAR_LENGTH(${sql.ref(columnName)}::text)) AS max_len
      FROM ${sql.table(tableName)}
    `.execute(this.db);
    return result.rows[0]?.max_len ?? 0;
  }

  /** Number of rows whose numeric value falls outside [min, max]. */
  async countOutOfRange(
    tableName: string,
    columnName: string,
    min: number,
    max: number,
  ): Promise<number> {
    const result = await sql<{ count: string }>`
      SELECT COUNT(*) AS count FROM ${sql.table(tableName)}
      WHERE ${sql.ref(columnName)} < ${min} OR ${sql.ref(columnName)} > ${max}
    `.execute(this.db);
    return Number.parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /** Number of rows where the column is NULL. */
  async countNulls(tableName: string, columnName: string): Promise<number> {
    const result = await sql<{ count: string }>`
      SELECT COUNT(*) AS count FROM ${sql.table(tableName)}
      WHERE ${sql.ref(columnName)} IS NULL
    `.execute(this.db);
    return Number.parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /** Sample of duplicated values (for unique-toggle preview errors). */
  async findDuplicateValues(
    tableName: string,
    columnName: string,
    limit = 5,
  ): Promise<{ value: string; count: number }[]> {
    const result = await sql<{ value: string | null; count: string }>`
      SELECT ${sql.ref(columnName)}::text AS value, COUNT(*) AS count
      FROM ${sql.table(tableName)}
      WHERE ${sql.ref(columnName)} IS NOT NULL
      GROUP BY ${sql.ref(columnName)}
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT ${limit}
    `.execute(this.db);
    return result.rows.map((r) => ({
      value: r.value ?? 'NULL',
      count: Number.parseInt(r.count, 10),
    }));
  }

  /**
   * Adds a foreign key constraint for a relationship.
   */
  async addForeignKey(
    tableName: string,
    columnName: string,
    referencedTable: string,
    referencedColumn: string,
    onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' = 'RESTRICT',
  ): Promise<string[]> {
    const constraintName = `fk_${tableName}_${columnName}_${referencedTable}`;

    await sql`
      ALTER TABLE ${sql.table(tableName)}
      ADD CONSTRAINT ${sql.ref(constraintName)}
      FOREIGN KEY (${sql.ref(columnName)})
      REFERENCES ${sql.table(referencedTable)} (${sql.ref(referencedColumn)})
      ON DELETE ${sql.raw(onDelete)}
    `.execute(this.db);

    return [
      `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${columnName}") REFERENCES "${referencedTable}" ("${referencedColumn}") ON DELETE ${onDelete}`,
    ];
  }

  /**
   * Creates a junction table for many-to-many relationships.
   */
  async createJunctionTable(
    junctionTableName: string,
    sourceTable: string,
    targetTable: string,
    sourceColumn: string,
    targetColumn: string,
  ): Promise<string[]> {
    const statements: string[] = [];

    await this.db.schema
      .createTable(junctionTableName)
      .addColumn(sourceColumn, 'uuid', (col) =>
        col.notNull().references(`${sourceTable}.id`).onDelete('cascade'),
      )
      .addColumn(targetColumn, 'uuid', (col) =>
        col.notNull().references(`${targetTable}.id`).onDelete('cascade'),
      )
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql.raw('NOW()')))
      .execute();

    statements.push(`CREATE TABLE "${junctionTableName}" (...)`);

    // Add composite primary key
    await sql`
      ALTER TABLE ${sql.table(junctionTableName)}
      ADD PRIMARY KEY (${sql.ref(sourceColumn)}, ${sql.ref(targetColumn)})
    `.execute(this.db);

    statements.push(
      `ALTER TABLE "${junctionTableName}" ADD PRIMARY KEY ("${sourceColumn}", "${targetColumn}")`,
    );

    // Index both columns for fast lookups
    const idx1 = `idx_${junctionTableName}_${sourceColumn}`;
    const idx2 = `idx_${junctionTableName}_${targetColumn}`;

    await this.db.schema.createIndex(idx1).on(junctionTableName).column(sourceColumn).execute();
    await this.db.schema.createIndex(idx2).on(junctionTableName).column(targetColumn).execute();

    statements.push(`CREATE INDEX "${idx1}"`, `CREATE INDEX "${idx2}"`);

    return statements;
  }

  /**
   * Creates an index on a table.
   */
  async createIndex(
    indexName: string,
    tableName: string,
    columns: string[],
    unique = false,
  ): Promise<string[]> {
    let builder = this.db.schema.createIndex(indexName).on(tableName);

    if (unique) {
      builder = builder.unique();
    }

    builder = builder.columns(columns);
    await builder.execute();

    const uniqueStr = unique ? 'UNIQUE ' : '';
    return [
      `CREATE ${uniqueStr}INDEX "${indexName}" ON "${tableName}" (${columns.map((c) => `"${c}"`).join(', ')})`,
    ];
  }

  /**
   * Drops an index.
   */
  async dropIndex(indexName: string): Promise<string[]> {
    await this.db.schema.dropIndex(indexName).ifExists().execute();
    return [`DROP INDEX IF EXISTS "${indexName}"`];
  }

  /**
   * Checks if a table exists in the database.
   */
  async tableExists(tableName: string): Promise<boolean> {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = ${tableName}
      ) as exists
    `.execute(this.db);

    return result.rows[0]?.exists ?? false;
  }

  /**
   * Describes a table's columns from the catalog (used by the drift doctor's
   * adopt action to import unmanaged tables/columns into metadata).
   */
  async describeTable(tableName: string): Promise<
    {
      column_name: string;
      data_type: string;
      udt_name: string;
      character_maximum_length: number | null;
      is_nullable: string;
      column_default: string | null;
    }[]
  > {
    const result = await sql<{
      column_name: string;
      data_type: string;
      udt_name: string;
      character_maximum_length: number | null;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT column_name, data_type, udt_name, character_maximum_length,
             is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
      ORDER BY ordinal_position
    `.execute(this.db);
    return result.rows;
  }

  /**
   * Checks if a column exists in a table.
   */
  async columnExists(tableName: string, columnName: string): Promise<boolean> {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
      ) as exists
    `.execute(this.db);

    return result.rows[0]?.exists ?? false;
  }

  /**
   * Gets the row count for a table.
   */
  async getRowCount(tableName: string): Promise<number> {
    const result = await sql<{ count: string }>`
      SELECT COUNT(*) as count FROM ${sql.table(tableName)}
    `.execute(this.db);

    return Number.parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Checks if a column has any non-null data.
   */
  async columnHasData(tableName: string, columnName: string): Promise<boolean> {
    const result = await sql<{ has_data: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM ${sql.table(tableName)}
        WHERE ${sql.ref(columnName)} IS NOT NULL
        LIMIT 1
      ) as has_data
    `.execute(this.db);

    return result.rows[0]?.has_data ?? false;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveColumnType(field: FieldDefinition): string {
    const typeInfo = COLUMN_TYPES[field.columnType];
    if (!typeInfo) {
      throw new Error(`Unknown column type: ${field.columnType}`);
    }
    return typeInfo.pg;
  }

  /** Renders a field's `defaultValue` into a SQL-ready DEFAULT expression. */
  private renderDefault(field: FieldDefinition): string {
    return renderDefaultExpression(field.defaultValue);
  }

  private getTypeDefault(columnType: ColumnTypeName): string {
    const defaults: Partial<Record<ColumnTypeName, string>> = {
      text: "''",
      short_text: "''",
      long_text: "''",
      integer: '0',
      big_integer: '0',
      decimal: '0',
      float: '0',
      boolean: 'false',
      date: 'CURRENT_DATE',
      datetime: 'NOW()',
      uuid: 'gen_random_uuid()',
      json: "'{}'::jsonb",
    };
    return defaults[columnType] ?? "''";
  }

  /**
   * Creates a trigger that auto-updates the `updated_at` column on row modification.
   */
  private async createUpdatedAtTrigger(tableName: string): Promise<void> {
    // Create the function if it doesn't exist (shared across all tables)
    await sql`
      CREATE OR REPLACE FUNCTION _ion_update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `.execute(this.db);

    // Create the trigger for this specific table
    const triggerName = `trg_${tableName}_updated_at`;
    await sql`
      CREATE OR REPLACE TRIGGER ${sql.raw(triggerName)}
      BEFORE UPDATE ON ${sql.table(tableName)}
      FOR EACH ROW
      EXECUTE FUNCTION _ion_update_updated_at()
    `.execute(this.db);
  }
}
