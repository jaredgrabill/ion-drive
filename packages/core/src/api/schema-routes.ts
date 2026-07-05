/**
 * Schema management API routes.
 *
 * These routes allow the admin console (and API consumers) to
 * create, read, update, and delete data objects and their fields
 * at runtime.
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { SchemaManager } from '../schema/index.js';
import { COLUMN_TYPES } from '../schema/types.js';
import type { ColumnTypeName, FieldDefinition } from '../schema/types.js';
import { recordSchemaChange } from '../telemetry/metrics.js';

// ---------------------------------------------------------------------------
// Zod schemas for request validation
// ---------------------------------------------------------------------------

const fieldSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z][a-z0-9_]*$/, 'Must start with a letter, lowercase, alphanumeric + underscores'),
  displayName: z.string().min(1).max(255),
  columnName: z.string().min(1).max(255).optional(),
  columnType: z.string().refine((v) => v in COLUMN_TYPES, 'Invalid column type'),
  isRequired: z.boolean().optional().default(false),
  isUnique: z.boolean().optional().default(false),
  isIndexed: z.boolean().optional().default(false),
  defaultValue: z.string().nullable().optional(),
  constraints: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
      enumValues: z.array(z.string()).optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const createObjectSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z][a-z0-9_]*$/, 'Must start with a letter, lowercase, alphanumeric + underscores'),
  displayName: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  tableName: z.string().min(1).max(255).optional(),
  fields: z.array(fieldSchema).default([]),
});

const addFieldSchema = fieldSchema;

const addRelationshipSchema = z.object({
  name: z.string().min(1).max(255),
  displayName: z.string().min(1).max(255),
  type: z.enum(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']),
  sourceObjectName: z.string().min(1),
  targetObjectName: z.string().min(1),
  cascadeDelete: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSchemaRoutes(schemaManager: SchemaManager): FastifyPluginCallback {
  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // --- List all objects ---
    fastify.get('/objects', async () => {
      const objects = schemaManager.listObjects();
      return {
        data: objects.map((obj) => ({
          name: obj.name,
          displayName: obj.displayName,
          description: obj.description,
          tableName: obj.tableName,
          isSystem: obj.isSystem,
          fieldCount: obj.fields.length,
          relationshipCount: obj.relationships?.length ?? 0,
        })),
        count: objects.length,
      };
    });

    // --- Get a single object (full definition) ---
    fastify.get<{ Params: { name: string } }>('/objects/:name', async (request, reply) => {
      const { name } = request.params;
      const obj = schemaManager.getObject(name);

      if (!obj) {
        return reply.code(404).send({
          error: 'Not Found',
          message: `Data object "${name}" not found`,
        });
      }

      return { data: obj };
    });

    // --- Create a new object ---
    fastify.post('/objects', async (request, reply) => {
      const parsed = createObjectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          issues: parsed.error.issues,
        });
      }

      const definition = parsed.data;
      const tableName = definition.tableName ?? definition.name;

      // Set columnName defaults
      const fields: FieldDefinition[] = definition.fields.map((f) => ({
        ...f,
        columnName: f.columnName ?? f.name,
        columnType: f.columnType as ColumnTypeName,
      }));

      const result = await schemaManager.createObject({
        name: definition.name,
        displayName: definition.displayName,
        description: definition.description,
        tableName,
        fields,
      });

      if (!result.success) {
        return reply.code(422).send({
          error: 'Schema Change Failed',
          preview: result.preview,
        });
      }

      recordSchemaChange('create_object', definition.name);
      return reply.code(201).send({
        data: result.object,
        preview: result.preview,
      });
    });

    // --- Delete an object ---
    fastify.delete<{ Params: { name: string } }>('/objects/:name', async (request, reply) => {
      const { name } = request.params;

      const result = await schemaManager.deleteObject(name);

      if (!result.success) {
        return reply.code(422).send({
          error: 'Schema Change Failed',
          preview: result.preview,
        });
      }

      recordSchemaChange('drop_object', name);
      return { success: true, preview: result.preview };
    });

    // --- Add a field to an object ---
    fastify.post<{ Params: { name: string } }>('/objects/:name/fields', async (request, reply) => {
      const { name } = request.params;
      const parsed = addFieldSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          issues: parsed.error.issues,
        });
      }

      const field: FieldDefinition = {
        ...parsed.data,
        columnName: parsed.data.columnName ?? parsed.data.name,
        columnType: parsed.data.columnType as ColumnTypeName,
      };

      const result = await schemaManager.addField(name, field);

      if (!result.success) {
        return reply.code(422).send({
          error: 'Schema Change Failed',
          preview: result.preview,
        });
      }

      recordSchemaChange('add_field', name);
      return reply.code(201).send({ success: true, preview: result.preview });
    });

    // --- Remove a field from an object ---
    fastify.delete<{ Params: { name: string; fieldName: string } }>(
      '/objects/:name/fields/:fieldName',
      async (request, reply) => {
        const { name, fieldName } = request.params;

        const result = await schemaManager.removeField(name, fieldName);

        if (!result.success) {
          return reply.code(422).send({
            error: 'Schema Change Failed',
            preview: result.preview,
          });
        }

        recordSchemaChange('drop_field', name);
        return { success: true, preview: result.preview };
      },
    );

    // --- Add a relationship ---
    fastify.post('/relationships', async (request, reply) => {
      const parsed = addRelationshipSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          issues: parsed.error.issues,
        });
      }

      const result = await schemaManager.addRelationship(parsed.data);

      if (!result.success) {
        return reply.code(422).send({
          error: 'Schema Change Failed',
          preview: result.preview,
        });
      }

      recordSchemaChange('add_relationship');
      return reply.code(201).send({ success: true, preview: result.preview });
    });

    // --- List available column types ---
    fastify.get('/column-types', async () => {
      const types = Object.entries(COLUMN_TYPES).map(([name, info]) => ({
        name,
        ...info,
      }));

      return {
        data: types,
        count: types.length,
      };
    });

    // --- Preview changes (dry run) ---
    fastify.post('/preview', async (request, reply) => {
      const body = request.body as { changes?: unknown[] };
      if (!body?.changes || !Array.isArray(body.changes)) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Request body must contain a "changes" array',
        });
      }

      const preview = await schemaManager.previewChanges(
        body.changes as Parameters<typeof schemaManager.previewChanges>[0],
      );

      return { data: preview };
    });

    done();
  };
}
