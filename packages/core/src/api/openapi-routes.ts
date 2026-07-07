/**
 * OpenAPI Spec Generator — Generates an OpenAPI 3.1 spec from the current schema state.
 *
 * The spec is always current — it's generated at request time from the
 * Schema Registry, so it reflects any runtime schema changes immediately.
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DeclaredAction } from '../blocks/action-executor.js';
import type { BlockHookDeclaration } from '../blocks/block-types.js';
import { listRelationKeys } from '../data/relation-keys.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { COLUMN_TYPES } from '../schema/types.js';
import type { ColumnTypeName, DataObjectDefinition, FieldDefinition } from '../schema/types.js';

export interface OpenApiRouteOptions {
  /**
   * Supplies the installed blocks' declared actions/hooks (Phase 14) so they
   * appear as operations. Fetched per spec request — always current, like the
   * schema itself.
   */
  actionSurface?: () => Promise<{
    actions: DeclaredAction[];
    hooks: { block: string; hook: BlockHookDeclaration }[];
  }>;
}

export function registerOpenApiRoutes(
  registry: SchemaRegistry,
  options: OpenApiRouteOptions = {},
): FastifyPluginCallback {
  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    fastify.get('/openapi.json', async (_request, reply) => {
      const spec = generateOpenApiSpec(registry);
      if (options.actionSurface) {
        addActionPaths(spec, await options.actionSurface());
      }
      return reply.header('content-type', 'application/json').send(spec);
    });

    done();
  };
}

/** Adds one operation per declared block action/hook to a generated spec (Phase 14). */
function addActionPaths(
  spec: Record<string, unknown>,
  surface: {
    actions: DeclaredAction[];
    hooks: { block: string; hook: BlockHookDeclaration }[];
  },
): void {
  const paths = spec.paths as Record<string, unknown>;
  const tags = spec.tags as { name: string; description?: string }[];
  const blocks = new Set<string>();

  for (const action of surface.actions) {
    blocks.add(action.block);
    paths[`/api/v1/blocks/${action.block}/actions/${action.name}`] = {
      post: {
        summary: action.description ?? `Invoke ${action.block}.${action.name}`,
        operationId: `action_${action.block}_${action.name}`,
        tags: [`Block: ${action.block}`],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: action.input ?? { type: 'object', additionalProperties: true },
            },
          },
        },
        responses: {
          '200': { description: 'Action result', content: { 'application/json': {} } },
          '400': { description: 'Input validation failed' },
          '404': { description: 'Block not installed or action not declared' },
        },
      },
    };
  }

  for (const { block, hook } of surface.hooks) {
    blocks.add(block);
    paths[`/api/v1/hooks/${block}/${hook.name}`] = {
      post: {
        summary: hook.description ?? `Inbound webhook ${block}.${hook.name}`,
        operationId: `hook_${block}_${hook.name}`,
        tags: [`Block: ${block}`],
        description:
          'Webhook endpoint for third-party deliveries. Session-auth exempt; the handler verifies provider signatures over the raw body.',
        requestBody: { required: false, content: { '*/*': {} } },
        responses: { '200': { description: 'Delivery accepted' } },
      },
    };
  }

  for (const block of [...blocks].sort()) {
    tags.push({
      name: `Block: ${block}`,
      description: `Actions and hooks of the "${block}" block`,
    });
  }
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

    // Link writes — one path per many_to_many relation key (Phase 13).
    for (const relKey of listRelationKeys(obj).filter((k) => k.via === 'junction')) {
      paths[`/api/v1/data/${obj.name}/{id}/links/${relKey.key}`] = generateLinkPath(
        obj,
        schemaName,
        relKey.key,
        relKey.otherObject,
      );
    }
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

  const schema = baseTypeSchema(field, typeInfo.category);
  applyConstraintKeywords(schema, field, typeInfo.category);
  return schema;
}

/** Maps a field's type category to its base JSON Schema (`type`/`format`/`items`/`enum`). */
function baseTypeSchema(field: FieldDefinition, category: string): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  switch (category) {
    case 'text':
      schema.type = 'string';
      applyTextFormat(schema, field);
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
      applyStructuredType(schema, field);
      break;
    case 'enum':
      schema.type = field.columnType === 'multi_enum' ? 'array' : 'string';
      applyEnumValues(schema, field);
      break;
    default:
      schema.type = 'string';
  }

  return schema;
}

/** Adds the `format` keyword for text types that have one (email, url). */
function applyTextFormat(schema: Record<string, unknown>, field: FieldDefinition): void {
  if (field.columnType === 'email') schema.format = 'email';
  if (field.columnType === 'url') schema.format = 'uri';
}

/** Sets the schema for structured types: `object` for json, typed `array` otherwise. */
function applyStructuredType(schema: Record<string, unknown>, field: FieldDefinition): void {
  if (field.columnType === 'json') {
    schema.type = 'object';
  } else {
    schema.type = 'array';
    schema.items = { type: field.columnType === 'array_integer' ? 'integer' : 'string' };
  }
}

/** Adds the enum membership (`enum` / array `items.enum`) from the field's constraints. */
function applyEnumValues(schema: Record<string, unknown>, field: FieldDefinition): void {
  if (!field.constraints?.enumValues) return;
  if (field.columnType === 'multi_enum') {
    schema.items = { type: 'string', enum: field.constraints.enumValues };
  } else {
    schema.enum = field.constraints.enumValues;
  }
}

/**
 * Adds constraint keywords mirroring the generated CHECK constraints (Phase
 * 10): numbers bound the value, text-like types bound the character length.
 */
function applyConstraintKeywords(
  schema: Record<string, unknown>,
  field: FieldDefinition,
  category: string,
): void {
  const isNumeric = category === 'number' || field.columnType === 'rating';
  if (field.constraints?.min !== undefined) {
    schema[isNumeric ? 'minimum' : 'minLength'] = field.constraints.min;
  }
  if (field.constraints?.max !== undefined) {
    schema[isNumeric ? 'maximum' : 'maxLength'] = field.constraints.max;
  }
  if (field.constraints?.pattern) schema.pattern = field.constraints.pattern;
  if (field.description) schema.description = field.description;
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
      description: expandDescription(obj),
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

/**
 * Documents the `expand` parameter with the object's actual relation keys
 * (FK, reverse `<obj>_by_<rel>`, and many_to_many — see data/relation-keys).
 */
function expandDescription(obj: DataObjectDefinition): string {
  const keys = listRelationKeys(obj);
  if (keys.length === 0) return 'Comma-separated relation keys (this object has none).';
  const listing = keys
    .map((k) => `${k.key} (${k.kind === 'single' ? 'one' : 'many'} ${k.otherObject})`)
    .join(', ');
  return `Comma-separated relation keys to attach related records. Available: ${listing}.`;
}

/** The POST/DELETE operations of one many_to_many link path (Phase 13). */
function generateLinkPath(
  obj: DataObjectDefinition,
  schemaName: string,
  relKey: string,
  otherObject: string,
): Record<string, unknown> {
  const parameters = [
    { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
  ];
  const requestBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              description: `Ids of ${otherObject} records to (un)link`,
            },
          },
        },
      },
    },
  };
  const resultResponse = (property: string) => ({
    '200': {
      description: `Links ${property}`,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              data: { type: 'object', properties: { [property]: { type: 'integer' } } },
            },
          },
        },
      },
    },
    '400': { description: 'Unknown relationship, not many_to_many, or invalid ids' },
    '404': { description: 'Record not found' },
  });

  return {
    post: {
      summary: `Link ${otherObject} to ${obj.displayName} via "${relKey}"`,
      operationId: `link${schemaName}${pascalCase(relKey)}`,
      tags: [obj.displayName],
      description: 'Adds many_to_many links. Idempotent — already-linked ids are skipped.',
      parameters,
      requestBody,
      responses: resultResponse('added'),
    },
    delete: {
      summary: `Unlink ${otherObject} from ${obj.displayName} via "${relKey}"`,
      operationId: `unlink${schemaName}${pascalCase(relKey)}`,
      tags: [obj.displayName],
      description: 'Removes many_to_many links. Ids that were not linked are ignored.',
      parameters,
      requestBody,
      responses: resultResponse('removed'),
    },
  };
}

function pascalCase(str: string): string {
  return str
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}
