/**
 * OpenAPI Spec Generator — Generates an OpenAPI 3.1 spec from the current schema state.
 *
 * The spec is always current — it's generated at request time from the
 * Schema Registry, so it reflects any runtime schema changes immediately.
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { COLUMN_TYPES } from '../schema/types.js';
import type { ColumnTypeName, DataObjectDefinition, FieldDefinition } from '../schema/types.js';

export function registerOpenApiRoutes(registry: SchemaRegistry): FastifyPluginCallback {
  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    fastify.get('/openapi.json', async (_request, reply) => {
      const spec = generateOpenApiSpec(registry);
      return reply.header('content-type', 'application/json').send(spec);
    });

    done();
  };
}

function generateOpenApiSpec(registry: SchemaRegistry): Record<string, unknown> {
  const objects = registry.listObjects().filter((o) => !o.isSystem);

  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  // --- Schema management paths ---
  paths['/api/v1/schema/objects'] = {
    get: {
      summary: 'List all data objects',
      operationId: 'listObjects',
      tags: ['Schema'],
      responses: {
        '200': {
          description: 'List of data objects',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
    post: {
      summary: 'Create a new data object',
      operationId: 'createObject',
      tags: ['Schema'],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CreateObjectInput' } },
        },
      },
      responses: {
        '201': { description: 'Object created' },
        '422': { description: 'Validation failed' },
      },
    },
  };

  // --- Data object CRUD paths (per object) ---
  for (const obj of objects) {
    const schemaName = pascalCase(obj.name);
    const tag = obj.displayName;

    // Generate schemas for this object
    schemas[schemaName] = generateObjectSchema(obj);
    schemas[`${schemaName}Input`] = generateInputSchema(obj);
    schemas[`${schemaName}ListResponse`] = {
      type: 'object',
      properties: {
        data: { type: 'array', items: { $ref: `#/components/schemas/${schemaName}` } },
        pagination: { $ref: '#/components/schemas/PaginationMeta' },
      },
    };

    // List + Create
    paths[`/api/v1/data/${obj.name}`] = {
      get: {
        summary: `List ${obj.displayName}`,
        operationId: `list${schemaName}`,
        tags: [tag],
        parameters: generateListParameters(obj),
        responses: {
          '200': {
            description: `List of ${obj.displayName}`,
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${schemaName}ListResponse` },
              },
            },
          },
        },
      },
      post: {
        summary: `Create ${obj.displayName}`,
        operationId: `create${schemaName}`,
        tags: [tag],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${schemaName}Input` },
            },
          },
        },
        responses: {
          '201': {
            description: `${obj.displayName} created`,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: `#/components/schemas/${schemaName}` } },
                },
              },
            },
          },
          '400': { description: 'Validation error' },
        },
      },
    };

    // Get + Update + Delete
    paths[`/api/v1/data/${obj.name}/{id}`] = {
      get: {
        summary: `Get ${obj.displayName} by ID`,
        operationId: `get${schemaName}`,
        tags: [tag],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: `${obj.displayName} found`,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: `#/components/schemas/${schemaName}` } },
                },
              },
            },
          },
          '404': { description: 'Not found' },
        },
      },
      patch: {
        summary: `Update ${obj.displayName}`,
        operationId: `update${schemaName}`,
        tags: [tag],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${schemaName}Input` },
            },
          },
        },
        responses: {
          '200': {
            description: `${obj.displayName} updated`,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: `#/components/schemas/${schemaName}` } },
                },
              },
            },
          },
          '404': { description: 'Not found' },
        },
      },
      delete: {
        summary: `Delete ${obj.displayName}`,
        operationId: `delete${schemaName}`,
        tags: [tag],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '204': { description: 'Deleted' },
          '404': { description: 'Not found' },
        },
      },
    };
  }

  // --- Shared schemas ---
  schemas.PaginationMeta = {
    type: 'object',
    properties: {
      page: { type: 'integer' },
      pageSize: { type: 'integer' },
      totalCount: { type: 'integer' },
      totalPages: { type: 'integer' },
      hasNextPage: { type: 'boolean' },
      hasPreviousPage: { type: 'boolean' },
    },
  };

  schemas.CreateObjectInput = {
    type: 'object',
    required: ['name', 'displayName'],
    properties: {
      name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      tableName: { type: 'string' },
      fields: { type: 'array', items: { $ref: '#/components/schemas/FieldInput' } },
    },
  };

  schemas.FieldInput = {
    type: 'object',
    required: ['name', 'displayName', 'columnType'],
    properties: {
      name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
      displayName: { type: 'string' },
      columnType: { type: 'string', enum: Object.keys(COLUMN_TYPES) },
      isRequired: { type: 'boolean' },
      isUnique: { type: 'boolean' },
      isIndexed: { type: 'boolean' },
      defaultValue: { type: 'string', nullable: true },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Ion Drive API',
      version: '0.1.0',
      description:
        'Dynamic data platform API. This spec is auto-generated from the current schema state and always reflects the latest object definitions.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Development' }],
    paths,
    components: { schemas },
    tags: [
      { name: 'Schema', description: 'Schema management — create and modify data objects' },
      ...objects.map((o) => ({
        name: o.displayName,
        description: o.description ?? `CRUD operations for ${o.displayName}`,
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateObjectSchema(obj: DataObjectDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of obj.fields) {
    properties[field.name] = fieldToJsonSchema(field);
    if (field.isRequired || field.isPrimary) {
      required.push(field.name);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function generateInputSchema(obj: DataObjectDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of obj.fields) {
    if (field.isSystem || field.isPrimary) continue;
    properties[field.name] = fieldToJsonSchema(field);
    if (field.isRequired) required.push(field.name);
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function fieldToJsonSchema(field: FieldDefinition): Record<string, unknown> {
  const typeInfo = COLUMN_TYPES[field.columnType as ColumnTypeName];
  if (!typeInfo) return { type: 'string' };

  const schema: Record<string, unknown> = {};

  switch (typeInfo.category) {
    case 'text':
      schema.type = 'string';
      if (field.columnType === 'email') schema.format = 'email';
      if (field.columnType === 'url') schema.format = 'uri';
      break;
    case 'number':
      schema.type =
        field.columnType === 'integer' || field.columnType === 'big_integer' ? 'integer' : 'number';
      break;
    case 'boolean':
      schema.type = 'boolean';
      break;
    case 'datetime':
      schema.type = 'string';
      schema.format = field.columnType === 'date' ? 'date' : 'date-time';
      break;
    case 'identity':
      schema.type = 'string';
      schema.format = 'uuid';
      break;
    case 'structured':
      if (field.columnType === 'json') {
        schema.type = 'object';
      } else {
        schema.type = 'array';
        schema.items = { type: field.columnType === 'array_integer' ? 'integer' : 'string' };
      }
      break;
    case 'enum':
      schema.type = field.columnType === 'multi_enum' ? 'array' : 'string';
      if (field.constraints?.enumValues) {
        if (field.columnType === 'multi_enum') {
          schema.items = { type: 'string', enum: field.constraints.enumValues };
        } else {
          schema.enum = field.constraints.enumValues;
        }
      }
      break;
    default:
      schema.type = 'string';
  }

  // Constraint keywords mirror the generated CHECK constraints (Phase 10):
  // numbers bound the value, text-like types bound the character length.
  const isNumeric = typeInfo.category === 'number' || field.columnType === 'rating';
  if (field.constraints?.min !== undefined) {
    schema[isNumeric ? 'minimum' : 'minLength'] = field.constraints.min;
  }
  if (field.constraints?.max !== undefined) {
    schema[isNumeric ? 'maximum' : 'maxLength'] = field.constraints.max;
  }
  if (field.constraints?.pattern) schema.pattern = field.constraints.pattern;
  if (field.description) schema.description = field.description;

  return schema;
}

function generateListParameters(obj: DataObjectDefinition): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [
    { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
    {
      name: 'limit',
      in: 'query',
      schema: { type: 'integer', maximum: 100 },
      description: 'Offset-based paging: max rows to return. Takes precedence over pageSize.',
    },
    {
      name: 'offset',
      in: 'query',
      schema: { type: 'integer', minimum: 0 },
      description: 'Offset-based paging: rows to skip. Takes precedence over page.',
    },
    {
      name: 'search',
      in: 'query',
      schema: { type: 'string' },
      description: 'Free-text search across all text-like columns (case-insensitive). Alias: q.',
    },
    {
      name: 'sort',
      in: 'query',
      schema: { type: 'string' },
      description: 'Sort fields, prefix with - for desc',
    },
    {
      name: 'expand',
      in: 'query',
      schema: { type: 'string' },
      description: 'Comma-separated relationship names',
    },
    {
      name: 'select',
      in: 'query',
      schema: { type: 'string' },
      description: 'Comma-separated field names',
    },
  ];

  // Add filter params for each non-system field
  for (const field of obj.fields) {
    if (field.isSystem) continue;
    params.push({
      name: field.name,
      in: 'query',
      required: false,
      schema: { type: 'string' },
      description: `Filter by ${field.displayName}. Use field[op]=value; operators (case-insensitive): eq, neq, gt, gte, lt, lte, like, ilike, in, nin, is_null, is_not_null.`,
    });
  }

  return params;
}

function pascalCase(str: string): string {
  return str
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}
