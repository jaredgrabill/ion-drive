/**
 * MCP Server — Model Context Protocol server for LLM agent integration.
 *
 * This is a first-class citizen of Ion Drive. It exposes the platform's
 * capabilities as MCP tools, resources, and prompts so that any
 * MCP-compatible AI agent can:
 *
 *   - Introspect the schema (list objects, get field definitions)
 *   - CRUD data across all data objects
 *   - Create/modify schema at runtime
 *   - Preview schema changes before committing
 *
 * Transport: Streamable HTTP (production) or stdio (development/testing)
 */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ActionError,
  type ActionExecutor,
  type DeclaredAction,
  mcpShapeForAction,
} from '../blocks/action-executor.js';
import type { InstalledBlock } from '../blocks/block-types.js';
import type { DataService } from '../data/data-service.js';
import { listRelationKeys } from '../data/relation-keys.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import type { ColumnTypeName, FieldConstraints, FieldDefinition } from '../schema/types.js';
import { COLUMN_TYPES } from '../schema/types.js';

/**
 * One-line human summary of a field for the schema-overview resource:
 * `name (type, required, unique, one of: a|b, min 1, max 9) — description`.
 */
function describeFieldForOverview(f: FieldDefinition): string {
  const notes = [
    f.columnType,
    f.isRequired ? 'required' : null,
    f.isUnique ? 'unique' : null,
    f.constraints?.enumValues ? `one of: ${f.constraints.enumValues.join('|')}` : null,
    f.constraints?.min !== undefined ? `min ${f.constraints.min}` : null,
    f.constraints?.max !== undefined ? `max ${f.constraints.max}` : null,
  ].filter(Boolean);
  return `${f.name} (${notes.join(', ')})${f.description ? ` — ${f.description}` : ''}`;
}

/** Field constraints as an MCP tool argument (mirrors FieldConstraints). */
const constraintsShape = z
  .object({
    min: z.number().optional().describe('Minimum value (numbers) or length (text)'),
    max: z.number().optional().describe('Maximum value (numbers) or length (text)'),
    pattern: z.string().optional().describe('POSIX regex the value must match'),
    enumValues: z.array(z.string()).optional().describe('Allowed values (select types)'),
    message: z.string().optional().describe('Custom validation message shown to API callers'),
  })
  .optional()
  .describe('Validation rules — enforced as PostgreSQL CHECK constraints');

export interface McpServerOptions {
  schemaManager: SchemaManager;
  dataService: DataService;
  /**
   * Block actions to expose as `<block>_<action>` tools (Phase 14). The list
   * is fetched by the transport plugin per request, so newly installed blocks
   * appear without restart — surface parity with REST and OpenAPI.
   */
  actions?: {
    declared: DeclaredAction[];
    executor: ActionExecutor;
  };
  /**
   * Installed-block ledger access for the `list_blocks` tool (spec-04
   * surface parity). Absent on headless setups without the block engine —
   * the tool simply isn't registered then.
   */
  blocks?: {
    listInstalled: () => Promise<InstalledBlock[]>;
  };
}

/**
 * Creates and configures the Ion Drive MCP server with all tools and resources.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { schemaManager, dataService } = options;

  const server = new McpServer({
    name: 'ion-drive',
    // The platform version, so agents see the real release (not a stale pin).
    version: createRequire(import.meta.url)('../../package.json').version as string,
  });

  // =========================================================================
  // Resources — Schema introspection for LLMs
  // =========================================================================

  server.resource('schema-overview', 'ion-drive://schema/overview', async () => {
    const objects = schemaManager.listObjects();
    const summary = objects.map((obj) => ({
      name: obj.name,
      displayName: obj.displayName,
      description: obj.description,
      fieldCount: obj.fields.length,
      fields: obj.fields.filter((f) => !f.isSystem).map(describeFieldForOverview),
    }));

    return {
      contents: [
        {
          uri: 'ion-drive://schema/overview',
          mimeType: 'application/json',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  });

  // =========================================================================
  // Tools — Schema Operations
  // =========================================================================

  server.tool(
    'list_objects',
    'List all data objects in the platform. Returns names, field counts, and descriptions.',
    {},
    async () => {
      const objects = schemaManager.listObjects();
      const result = objects.map((obj) => ({
        name: obj.name,
        displayName: obj.displayName,
        description: obj.description,
        tableName: obj.tableName,
        isSystem: obj.isSystem,
        fieldCount: obj.fields.length,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'get_object',
    'Get the full definition of a data object including all fields, types, constraints, relationships, and the relation keys accepted by expand/link tools.',
    { object_name: z.string().describe('Name of the data object (e.g., "contacts")') },
    async ({ object_name }) => {
      const obj = schemaManager.getObject(object_name);
      if (!obj) {
        return {
          content: [{ type: 'text' as const, text: `Error: Object "${object_name}" not found` }],
          isError: true,
        };
      }

      // The derived expand/link addresses (Phase 13) — saves agents from
      // re-deriving the reverse-key grammar.
      const relationKeys = listRelationKeys(obj).map((k) => ({
        key: k.key,
        kind: k.kind,
        otherObject: k.otherObject,
        via: k.via,
      }));

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ...obj, relationKeys }, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'create_object',
    'Create a new data object (table) with the given fields. System fields (id, created_at, updated_at) are added automatically.',
    {
      name: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/)
        .describe('Object name (lowercase, underscores)'),
      display_name: z.string().describe('Human-readable display name'),
      description: z.string().optional().describe('Optional description'),
      fields: z
        .array(
          z.object({
            name: z
              .string()
              .regex(/^[a-z][a-z0-9_]*$/)
              .describe('Field name'),
            display_name: z.string().describe('Human-readable field name'),
            column_type: z
              .string()
              .describe(`Column type: ${Object.keys(COLUMN_TYPES).join(', ')}`),
            is_required: z.boolean().optional().describe('Whether the field is required'),
            is_unique: z.boolean().optional().describe('Whether the field must be unique'),
            is_indexed: z.boolean().optional().describe('Whether to create an index'),
            default_value: z.string().optional().describe('SQL default value expression'),
            description: z.string().optional().describe('What this field holds (for agents/docs)'),
            constraints: constraintsShape,
          }),
        )
        .describe('Field definitions'),
      unique_together: z
        .array(z.array(z.string()).min(2))
        .optional()
        .describe(
          'Composite unique constraints: groups of 2+ field names unique together, e.g. [["room_code","seed"]] — enforced as UNIQUE constraints and valid upsert conflict targets',
        ),
    },
    async ({ name, display_name, description, fields, unique_together }) => {
      const result = await schemaManager.createObject({
        name,
        displayName: display_name,
        description,
        tableName: name,
        fields: fields.map((f) => ({
          name: f.name,
          displayName: f.display_name,
          columnName: f.name,
          columnType: f.column_type as ColumnTypeName,
          isRequired: f.is_required,
          isUnique: f.is_unique,
          isIndexed: f.is_indexed,
          defaultValue: f.default_value,
          description: f.description,
          constraints: f.constraints as FieldConstraints | undefined,
        })),
        constraints: unique_together ? { uniqueTogether: unique_together } : undefined,
      });

      if (!result.success) {
        const errors = result.preview.errors.map((e) => e.message).join('; ');
        return {
          content: [{ type: 'text' as const, text: `Error: ${errors}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                object: result.object,
                warnings: result.preview.warnings.map((w) => w.message),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'add_field',
    'Add a new field (column) to an existing data object.',
    {
      object_name: z.string().describe('Name of the data object'),
      name: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/)
        .describe('Field name'),
      display_name: z.string().describe('Human-readable field name'),
      column_type: z.string().describe(`Column type: ${Object.keys(COLUMN_TYPES).join(', ')}`),
      is_required: z.boolean().optional().describe('Whether the field is required'),
      is_unique: z.boolean().optional().describe('Whether the field must be unique'),
      is_indexed: z.boolean().optional().describe('Whether to create an index'),
      description: z.string().optional().describe('What this field holds (for agents/docs)'),
      constraints: constraintsShape,
    },
    async ({
      object_name,
      name,
      display_name,
      column_type,
      is_required,
      is_unique,
      is_indexed,
      description,
      constraints,
    }) => {
      const result = await schemaManager.addField(object_name, {
        name,
        displayName: display_name,
        columnName: name,
        columnType: column_type as ColumnTypeName,
        isRequired: is_required,
        isUnique: is_unique,
        isIndexed: is_indexed,
        description,
        constraints: constraints as FieldConstraints | undefined,
      });

      if (!result.success) {
        const errors = result.preview.errors.map((e) => e.message).join('; ');
        return {
          content: [{ type: 'text' as const, text: `Error: ${errors}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Field "${name}" added to "${object_name}" successfully.`,
          },
        ],
      };
    },
  );

  server.tool(
    'modify_field',
    'Modify an existing field: rename, change type, toggle required/unique/indexed, set default, or change validation constraints. Changes are validated against existing data first (e.g. narrowing a type checks current values; making a field required needs a backfill_value if NULLs exist). Use dry_run to preview the SQL and warnings without applying. Fields owned by a building block reject structural changes unless force is set.',
    {
      object_name: z.string().describe('Name of the data object'),
      field_name: z.string().describe('Current name of the field to modify'),
      new_name: z.string().optional().describe('Rename the field (changes the API name)'),
      display_name: z.string().optional().describe('New display name'),
      description: z.string().optional().describe('New field description'),
      column_type: z
        .string()
        .optional()
        .describe(
          `Change the column type (validated for compatibility): ${Object.keys(COLUMN_TYPES).join(', ')}`,
        ),
      is_required: z.boolean().optional().describe('Toggle NOT NULL'),
      is_unique: z.boolean().optional().describe('Toggle uniqueness (pre-checks duplicates)'),
      is_indexed: z.boolean().optional().describe('Toggle index'),
      default_value: z.string().nullable().optional().describe('Set (or null to clear) default'),
      constraints: constraintsShape,
      backfill_value: z
        .string()
        .optional()
        .describe('Value written into existing NULL rows when setting is_required'),
      dry_run: z.boolean().optional().describe('Preview only — return SQL + warnings'),
      force: z.boolean().optional().describe('Override block contract protection'),
    },
    async (args) => {
      const result = await schemaManager.modifyField(
        args.object_name,
        args.field_name,
        {
          name: args.new_name,
          displayName: args.display_name,
          description: args.description,
          columnType: args.column_type as ColumnTypeName | undefined,
          isRequired: args.is_required,
          isUnique: args.is_unique,
          isIndexed: args.is_indexed,
          defaultValue: args.default_value,
          constraints: args.constraints as FieldConstraints | undefined,
          backfillValue: args.backfill_value,
        },
        { dryRun: args.dry_run, force: args.force },
      );

      const summary = {
        success: result.success,
        dryRun: args.dry_run ?? false,
        sql: result.preview.sqlStatements,
        warnings: result.preview.warnings.map((w) => w.message),
        errors: result.preview.errors.map((e) => e.message),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
        isError: !result.success && !args.dry_run,
      };
    },
  );

  server.tool(
    'set_unique_together',
    "Replace a data object's composite unique constraints (uniqueTogether). Declarative: the given groups become the full set — omitted groups are dropped, new ones added. Adding a group pre-checks existing data and fails with named duplicate combinations. Use dry_run to preview the SQL; objects owned by a building block require force.",
    {
      object_name: z.string().describe('Name of the data object'),
      unique_together: z
        .array(z.array(z.string()).min(2))
        .describe('Groups of 2+ field names unique together (empty array drops all groups)'),
      dry_run: z.boolean().optional().describe('Preview only — return SQL + warnings'),
      force: z.boolean().optional().describe('Override block contract protection'),
    },
    async (args) => {
      const result = await schemaManager.setObjectConstraints(
        args.object_name,
        { uniqueTogether: args.unique_together },
        { dryRun: args.dry_run, force: args.force },
      );
      const summary = {
        success: result.success,
        dryRun: args.dry_run ?? false,
        sql: result.preview.sqlStatements,
        warnings: result.preview.warnings.map((w) => w.message),
        errors: result.preview.errors.map((e) => e.message),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
        isError: !result.success && !args.dry_run,
      };
    },
  );

  server.tool(
    'delete_object',
    'Delete a data object and its table. WARNING: This permanently deletes all data.',
    {
      object_name: z.string().describe('Name of the data object to delete'),
    },
    async ({ object_name }) => {
      const result = await schemaManager.deleteObject(object_name);

      if (!result.success) {
        const errors = result.preview.errors.map((e) => e.message).join('; ');
        return {
          content: [{ type: 'text' as const, text: `Error: ${errors}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Object "${object_name}" deleted successfully.` }],
      };
    },
  );

  server.tool(
    'add_relationship',
    'Create a relationship between two data objects. FK-backed types (one_to_one, one_to_many, many_to_one) add a "<name>_id" column on the "many" side; many_to_many creates a junction table (write links with link_records). Related records are then readable via expand on query_data/get_record.',
    {
      name: z
        .string()
        .describe('Relationship name, lowercase snake case (the FK column becomes "<name>_id")'),
      display_name: z.string().describe('Human-readable name'),
      type: z.enum(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']),
      source_object_name: z.string().describe('The relationship source object'),
      target_object_name: z.string().describe('The relationship target object'),
      cascade_delete: z
        .boolean()
        .optional()
        .describe('Delete dependents with the referenced record (default: restrict)'),
    },
    async (args) => {
      const result = await schemaManager.addRelationship({
        name: args.name,
        displayName: args.display_name,
        type: args.type,
        sourceObjectName: args.source_object_name,
        targetObjectName: args.target_object_name,
        cascadeDelete: args.cascade_delete,
      });
      const summary = {
        success: result.success,
        warnings: result.preview.warnings.map((w) => w.message),
        errors: result.preview.errors.map((e) => e.message),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
        isError: !result.success,
      };
    },
  );

  server.tool(
    'remove_relationship',
    'Remove a relationship (Phase 13). PERMANENT: the FK column (and its stored links) or the many_to_many junction table (and its link rows) are dropped. Use dry_run first to see the SQL and data-loss warnings; relationships owned by a building block require force.',
    {
      source_object_name: z
        .string()
        .describe('The relationship source object (relationship names are scoped per source)'),
      relationship_name: z.string().describe('Name of the relationship to remove'),
      dry_run: z.boolean().optional().describe('Preview only — return SQL + warnings'),
      force: z.boolean().optional().describe('Override block contract protection'),
    },
    async (args) => {
      const result = await schemaManager.removeRelationship(
        args.source_object_name,
        args.relationship_name,
        { dryRun: args.dry_run, force: args.force },
      );
      const summary = {
        success: result.success,
        dryRun: args.dry_run ?? false,
        sql: result.preview.sqlStatements,
        warnings: result.preview.warnings.map((w) => w.message),
        errors: result.preview.errors.map((e) => e.message),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
        isError: !result.success && !args.dry_run,
      };
    },
  );

  server.tool(
    'list_column_types',
    'List all available column types with their PostgreSQL mappings and categories.',
    {},
    async () => {
      const types = Object.entries(COLUMN_TYPES).map(([name, info]) => ({
        name,
        postgresType: info.pg,
        category: info.category,
        label: info.label,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(types, null, 2) }],
      };
    },
  );

  // =========================================================================
  // Tools — Data Operations (CRUD)
  // =========================================================================

  server.tool(
    'query_data',
    'Query records from a data object with optional filtering, free-text search, sorting, pagination, and relationship expansion.',
    {
      object_name: z.string().describe('Name of the data object to query'),
      search: z
        .string()
        .optional()
        .describe('Free-text search across the object text-like columns (case-insensitive)'),
      filters: z
        .array(
          z.object({
            field: z.string(),
            operator: z.enum([
              'eq',
              'neq',
              'gt',
              'gte',
              'lt',
              'lte',
              'like',
              'ilike',
              'in',
              'nin',
              'is_null',
              'is_not_null',
            ]),
            value: z.unknown(),
          }),
        )
        .optional()
        .describe('Filter conditions'),
      sort: z
        .array(
          z.object({
            field: z.string(),
            direction: z.enum(['asc', 'desc']),
          }),
        )
        .optional()
        .describe('Sort order'),
      page: z.number().optional().describe('Page number (default: 1)'),
      page_size: z.number().optional().describe('Page size (default: 25, max: 100)'),
      limit: z.number().optional().describe('Offset-based: max rows to return (max: 100)'),
      offset: z.number().optional().describe('Offset-based: rows to skip'),
      expand: z
        .array(z.string())
        .optional()
        .describe(
          'Relation keys to expand — related records attach under the key. Keys: the relationship name (single record on the FK side; list for many_to_many), or "<fkObject>_by_<relationship>" for the reverse side (e.g. "contacts_by_company" on companies — the children list). See get_object for the object relationships.',
        ),
    },
    async ({ object_name, search, filters, sort, page, page_size, limit, offset, expand }) => {
      try {
        const result = await dataService.list(object_name, {
          filters: filters as NonNullable<Parameters<typeof dataService.list>[1]>['filters'],
          search,
          sort,
          pagination: { page: page ?? 1, pageSize: page_size ?? 25, limit, offset },
          expand,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'aggregate_data',
    'Compute a single aggregate (count, sum, avg, min, max) over the records matching the same filters/search as query_data. count needs no field; sum/avg/min/max require a numeric field. The result always includes filteredCount (the matching-row count). Rank pattern: filter on the score being beaten (e.g. wins gt <mine>) with fn=count — rank is filteredCount + 1.',
    {
      object_name: z.string().describe('Name of the data object to aggregate'),
      fn: z
        .enum(['count', 'sum', 'avg', 'min', 'max'])
        .describe('The aggregate function to compute'),
      field: z
        .string()
        .optional()
        .describe(
          'Field to aggregate — required for sum/avg/min/max (numeric fields only); optional for count (counts non-null values of the field)',
        ),
      search: z
        .string()
        .optional()
        .describe('Free-text search across the object text-like columns (case-insensitive)'),
      filters: z
        .array(
          z.object({
            field: z.string(),
            operator: z.enum([
              'eq',
              'neq',
              'gt',
              'gte',
              'lt',
              'lte',
              'like',
              'ilike',
              'in',
              'nin',
              'is_null',
              'is_not_null',
            ]),
            value: z.unknown(),
          }),
        )
        .optional()
        .describe('Filter conditions (same shape as query_data)'),
    },
    async ({ object_name, fn, field, search, filters }) => {
      try {
        const result = await dataService.aggregate(object_name, fn, field, {
          filters: filters as NonNullable<Parameters<typeof dataService.aggregate>[3]>['filters'],
          search,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_record',
    'Get a single record by its ID, optionally expanding related records.',
    {
      object_name: z.string().describe('Name of the data object'),
      id: z.string().describe('Record UUID'),
      expand: z
        .array(z.string())
        .optional()
        .describe(
          'Relation keys to expand — related records attach under the key. Keys: the relationship name (single record on the FK side; list for many_to_many), or "<fkObject>_by_<relationship>" for the reverse side (e.g. "contacts_by_company" on companies — the children list). See get_object for the object relationships.',
        ),
    },
    async ({ object_name, id, expand }) => {
      try {
        const result = await dataService.getById(object_name, id, { expand });
        if (!result) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Record "${id}" not found in "${object_name}"`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'create_record',
    'Create a new record in a data object.',
    {
      object_name: z.string().describe('Name of the data object'),
      data: z.record(z.unknown()).describe('Field values for the new record'),
    },
    async ({ object_name, data }) => {
      try {
        const result = await dataService.create(object_name, data);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'update_record',
    'Update an existing record by its ID. Use "increment" for atomic counter adds — { "wins": 1 } compiles to SET wins = wins + 1 in one statement (concurrency-safe; negative amounts subtract). Numeric fields in "data" also accept the { "$inc": n } operator shape directly.',
    {
      object_name: z.string().describe('Name of the data object'),
      id: z.string().describe('Record UUID'),
      data: z.record(z.unknown()).optional().describe('Fields to set'),
      increment: z
        .record(z.number())
        .optional()
        .describe('Numeric fields to atomically add to: { field: amount }'),
    },
    async ({ object_name, id, data, increment }) => {
      try {
        const payload: Record<string, unknown> = { ...(data ?? {}) };
        for (const [field, amount] of Object.entries(increment ?? {})) {
          if (field in payload) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: Field "${field}" cannot be both set (data) and incremented (increment)`,
                },
              ],
              isError: true,
            };
          }
          payload[field] = { $inc: amount };
        }
        if (Object.keys(payload).length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Error: Provide "data" and/or "increment"' }],
            isError: true,
          };
        }
        const result = await dataService.update(object_name, id, payload);
        if (!result) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Record "${id}" not found in "${object_name}"`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'upsert_record',
    'Create or update a record in one atomic statement (INSERT … ON CONFLICT DO UPDATE). on_conflict must name a declared unique target: a single isUnique field, the primary key, or one of the object\'s uniqueTogether groups. Returns the row plus "created" (true = inserted, false = updated).',
    {
      object_name: z.string().describe('Name of the data object'),
      data: z
        .record(z.unknown())
        .describe('Field values (must include the conflict target columns)'),
      on_conflict: z
        .array(z.string())
        .min(1)
        .describe('Column(s) of the unique constraint to resolve conflicts on'),
    },
    async ({ object_name, data, on_conflict }) => {
      try {
        const result = await dataService.upsert(object_name, data, on_conflict);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'delete_record',
    'Delete a record by its ID.',
    {
      object_name: z.string().describe('Name of the data object'),
      id: z.string().describe('Record UUID'),
    },
    async ({ object_name, id }) => {
      try {
        const deleted = await dataService.delete(object_name, id);
        if (!deleted) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Record "${id}" not found in "${object_name}"`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Record "${id}" deleted from "${object_name}" successfully.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'link_records',
    'Add many_to_many links between a record and target records (Phase 13). Idempotent — already-linked pairs are skipped. FK-backed relationships are set via the record\'s "<relationship>_id" field with update_record instead.',
    {
      object_name: z.string().describe('Name of the data object holding the record'),
      id: z.string().describe('Record UUID whose links to add'),
      relationship: z.string().describe('The many_to_many relationship name'),
      target_ids: z.array(z.string()).describe('UUIDs of the records to link'),
    },
    async ({ object_name, id, relationship, target_ids }) => {
      try {
        const result = await dataService.addLinks(object_name, id, relationship, target_ids);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'unlink_records',
    'Remove many_to_many links between a record and target records (Phase 13). Ids that were not linked are ignored.',
    {
      object_name: z.string().describe('Name of the data object holding the record'),
      id: z.string().describe('Record UUID whose links to remove'),
      relationship: z.string().describe('The many_to_many relationship name'),
      target_ids: z.array(z.string()).describe('UUIDs of the records to unlink'),
    },
    async ({ object_name, id, relationship, target_ids }) => {
      try {
        const result = await dataService.removeLinks(object_name, id, relationship, target_ids);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Prompts — Pre-built prompt templates for common operations
  // =========================================================================

  server.prompt(
    'explore-schema',
    'Generate a summary of all data objects and their relationships for context.',
    async () => {
      const objects = schemaManager.listObjects();
      const objectSummaries = objects.map((obj) => {
        const fields = obj.fields
          .filter((f) => !f.isSystem)
          .map(
            (f) =>
              `  - ${f.name}: ${f.columnType}${f.isRequired ? ' (required)' : ''}${f.isUnique ? ' (unique)' : ''}`,
          )
          .join('\n');
        return `## ${obj.displayName} (${obj.name})\n${obj.description ?? 'No description'}\n\nFields:\n${fields}`;
      });

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Here is the current Ion Drive schema with ${objects.length} data object(s):\n\n${objectSummaries.join('\n\n---\n\n')}\n\nPlease summarize this schema and identify any potential improvements.`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    'design-object',
    'Help design a new data object by providing requirements.',
    { description: z.string().describe('Describe the data object you need') },
    async ({ description }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `I need to design a new data object for Ion Drive. Here's what I need:\n\n${description}\n\nPlease suggest:\n1. An appropriate object name (lowercase, underscores)\n2. A display name\n3. Field definitions with appropriate column types\n4. Which fields should be required, unique, or indexed\n5. Any relationships to existing objects\n\nAvailable column types: ${Object.keys(COLUMN_TYPES).join(', ')}\n\nThen call the create_object tool with your recommendation.`,
          },
        },
      ],
    }),
  );

  // =========================================================================
  // Tools — Block actions (Phase 14): one tool per declared action
  // =========================================================================

  if (options.actions) {
    const { declared, executor } = options.actions;
    for (const action of declared) {
      registerActionTool(server, executor, action);
    }
  }

  // Installed-block ledger, provenance included (spec-04 surface parity with
  // GET /api/v1/blocks). Gated on the engine being wired so headless setups
  // (no block engine) simply lack the tool.
  if (options.blocks) {
    const blocks = options.blocks;
    server.tool(
      'list_blocks',
      'List installed building blocks with their install provenance (version, status, trust tier, artifact digest, publisher). To upgrade an installed block to a newer version, use the ion-drive CLI: `ion-drive update <name>`.',
      {},
      async () => {
        const installed = await blocks.listInstalled();
        const result = installed.map((b) => ({
          name: b.name,
          version: b.version,
          status: b.status,
          title: b.title,
          trustTier: b.trustTier,
          artifactDigest: b.artifactDigest,
          publisher: b.publisher,
          installedAt: b.installedAt,
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }

  return server;
}

/**
 * Registers one `<block>_<action>` tool that invokes a block action through
 * the shared {@link ActionExecutor} (same validation/timeout/metrics path as
 * the REST route). Tool parameters mirror the handler's registered Zod object
 * schema; without one, a single opaque `input` record is accepted.
 */
function registerActionTool(
  server: McpServer,
  executor: ActionExecutor,
  action: DeclaredAction,
): void {
  const registered = executor.getRegisteredAction(action.block, action.name);
  const shape = mcpShapeForAction(registered);
  const usesFallbackShape = !(registered?.input instanceof z.ZodObject);

  server.tool(
    `${action.block}_${action.name}`,
    action.description ??
      `Invoke the "${action.name}" action of the "${action.block}" building block.`,
    shape,
    async (args: Record<string, unknown>) => {
      try {
        const { definition } = await executor.resolveAction(action.block, action.name);
        // Fallback shape wraps the payload under `input` — unwrap before executing.
        const payload =
          usesFallbackShape && args && typeof args.input === 'object' && args.input !== null
            ? (args.input as Record<string, unknown>)
            : args;
        const result = await executor.executeAction(definition, payload, null);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }],
        };
      } catch (err) {
        const message =
          err instanceof ActionError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        return { content: [{ type: 'text' as const, text: `Error — ${message}` }], isError: true };
      }
    },
  );
}
