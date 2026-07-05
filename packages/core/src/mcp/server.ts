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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DataService } from '../data/data-service.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import type { ColumnTypeName } from '../schema/types.js';
import { COLUMN_TYPES } from '../schema/types.js';

export interface McpServerOptions {
  schemaManager: SchemaManager;
  dataService: DataService;
}

/**
 * Creates and configures the Ion Drive MCP server with all tools and resources.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { schemaManager, dataService } = options;

  const server = new McpServer({
    name: 'ion-drive',
    version: '0.1.0',
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
      fields: obj.fields
        .filter((f) => !f.isSystem)
        .map((f) => `${f.name} (${f.columnType}${f.isRequired ? ', required' : ''})`),
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
    'Get the full definition of a data object including all fields, types, constraints, and relationships.',
    { object_name: z.string().describe('Name of the data object (e.g., "contacts")') },
    async ({ object_name }) => {
      const obj = schemaManager.getObject(object_name);
      if (!obj) {
        return {
          content: [{ type: 'text' as const, text: `Error: Object "${object_name}" not found` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
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
          }),
        )
        .describe('Field definitions'),
    },
    async ({ name, display_name, description, fields }) => {
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
        })),
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
    },
    async ({
      object_name,
      name,
      display_name,
      column_type,
      is_required,
      is_unique,
      is_indexed,
    }) => {
      const result = await schemaManager.addField(object_name, {
        name,
        displayName: display_name,
        columnName: name,
        columnType: column_type as ColumnTypeName,
        isRequired: is_required,
        isUnique: is_unique,
        isIndexed: is_indexed,
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
    'Query records from a data object with optional filtering, free-text search, sorting, and pagination.',
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
    },
    async ({ object_name, search, filters, sort, page, page_size, limit, offset }) => {
      try {
        const result = await dataService.list(object_name, {
          filters: filters as NonNullable<Parameters<typeof dataService.list>[1]>['filters'],
          search,
          sort,
          pagination: { page: page ?? 1, pageSize: page_size ?? 25, limit, offset },
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
    'Get a single record by its ID.',
    {
      object_name: z.string().describe('Name of the data object'),
      id: z.string().describe('Record UUID'),
    },
    async ({ object_name, id }) => {
      try {
        const result = await dataService.getById(object_name, id);
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
    'Update an existing record by its ID.',
    {
      object_name: z.string().describe('Name of the data object'),
      id: z.string().describe('Record UUID'),
      data: z.record(z.unknown()).describe('Fields to update'),
    },
    async ({ object_name, id, data }) => {
      try {
        const result = await dataService.update(object_name, id, data);
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

  return server;
}
