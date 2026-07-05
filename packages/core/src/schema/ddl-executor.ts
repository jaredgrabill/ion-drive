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

    return statements;
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
