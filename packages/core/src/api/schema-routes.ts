/**
 * Schema management API routes.
 *
 * These routes allow the admin console (and API consumers) to
 * create, read, update, and delete data objects and their fields
 * at runtime.
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { SchemaDoctor } from '../schema/doctor.js';
import type { SchemaManager } from '../schema/index.js';
import {
  type SchemaSnapshot,
  applySnapshot,
  diffSnapshot,
  exportSnapshot,
} from '../schema/snapshot.js';
import { COLUMN_TYPES } from '../schema/types.js';
import type { ColumnTypeName, FieldDefinition } from '../schema/types.js';
import { recordSchemaChange } from '../telemetry/metrics.js';

// ---------------------------------------------------------------------------
// Zod schemas for request validation
// ---------------------------------------------------------------------------

const constraintsSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  pattern: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  message: z.string().optional(),
});

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
  constraints: constraintsSchema.optional(),
  description: z.string().max(2000).nullable().optional(),
  uiOptions: z.record(z.unknown()).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

/** Partial update for PATCH /objects/:name/fields/:fieldName (Phase 10). */
const modifyFieldSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        'Must start with a letter, lowercase, alphanumeric + underscores',
      ),
    displayName: z.string().min(1).max(255),
    description: z.string().max(2000).nullable(),
    uiOptions: z.record(z.unknown()).nullable(),
    columnType: z.string().refine((v) => v in COLUMN_TYPES, 'Invalid column type'),
    isRequired: z.boolean(),
    isUnique: z.boolean(),
    isIndexed: z.boolean(),
    defaultValue: z.string().nullable(),
    constraints: constraintsSchema.nullable(),
    sortOrder: z.number().int(),
    backfillValue: z.string(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field property must be provided');

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

/** The wire shape POST /snapshot accepts (validated loosely; the schema engine re-validates). */
const snapshotSchema = z.object({
  formatVersion: z.number().int(),
  exportedAt: z.string().optional(),
  objects: z.array(
    z.object({
      name: z.string(),
      displayName: z.string(),
      description: z.string().optional(),
      managedBy: z.string().optional(),
      fields: z.array(z.record(z.unknown())),
    }),
  ),
  relationships: z.array(z.record(z.unknown())).default([]),
});

export interface SchemaRoutesOptions {
  /** Enables /doctor endpoints when provided. */
  doctor?: SchemaDoctor;
}

export function registerSchemaRoutes(
  schemaManager: SchemaManager,
  options: SchemaRoutesOptions = {},
): FastifyPluginCallback {
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

    // --- Modify a field (rename/type/flags/default/constraints/metadata) ---
    // Preview-first contract: ?dryRun=true returns the ChangePreview without
    // applying; ?force=true overrides block contract protection (ADR-017).
    fastify.patch<{
      Params: { name: string; fieldName: string };
      Querystring: { dryRun?: string; force?: string };
    }>('/objects/:name/fields/:fieldName', async (request, reply) => {
      const { name, fieldName } = request.params;
      const parsed = modifyFieldSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          issues: parsed.error.issues,
        });
      }

      const dryRun = request.query.dryRun === 'true';
      const force = request.query.force === 'true';
      const updates = {
        ...parsed.data,
        columnType: parsed.data.columnType as ColumnTypeName | undefined,
      };

      const result = await schemaManager.modifyField(name, fieldName, updates, { dryRun, force });

      if (dryRun) {
        return { data: result.preview };
      }
      if (!result.success) {
        return reply.code(422).send({
          error: 'Schema Change Failed',
          preview: result.preview,
        });
      }

      recordSchemaChange('modify_field', name);
      return { success: true, preview: result.preview, field: result.field };
    });

    // --- Remove a field from an object ---
    fastify.delete<{
      Params: { name: string; fieldName: string };
      Querystring: { force?: string };
    }>('/objects/:name/fields/:fieldName', async (request, reply) => {
      const { name, fieldName } = request.params;

      const result = await schemaManager.removeField(name, fieldName, {
        force: request.query.force === 'true',
      });

      if (!result.success) {
        return reply.code(422).send({
          error: 'Schema Change Failed',
          preview: result.preview,
        });
      }

      recordSchemaChange('drop_field', name);
      return { success: true, preview: result.preview };
    });

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

    // --- Remove a relationship (Phase 13 / F17) ---
    // Names are scoped per source object, so the address is the pair.
    // Preview-first: ?dryRun=true returns the ChangePreview (data-loss
    // warnings, real SQL) without applying; ?force=true overrides block
    // contract protection (ADR-017).
    fastify.delete<{
      Params: { name: string; relName: string };
      Querystring: { dryRun?: string; force?: string };
    }>('/objects/:name/relationships/:relName', async (request, reply) => {
      const { name, relName } = request.params;
      const dryRun = request.query.dryRun === 'true';

      const result = await schemaManager.removeRelationship(name, relName, {
        dryRun,
        force: request.query.force === 'true',
      });

      if (dryRun) {
        return { data: result.preview };
      }
      if (!result.success) {
        return reply.code(422).send({
          error: 'Schema Change Failed',
          preview: result.preview,
        });
      }

      recordSchemaChange('remove_relationship', name);
      return { success: true, preview: result.preview };
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

    // --- Schema snapshot: export (Phase 10 / 4A) ---
    fastify.get('/snapshot', async () => {
      return { data: exportSnapshot(schemaManager.listObjects()) };
    });

    // --- Schema snapshot: diff / apply (Phase 10 / 4A) ---
    // ?dryRun=true returns the computed diff without applying; ?prune=true also
    // removes fields/objects absent from the snapshot; ?force=true overrides
    // block contract protection on modified fields.
    fastify.post<{ Querystring: { dryRun?: string; prune?: string; force?: string } }>(
      '/snapshot',
      async (request, reply) => {
        const parsed = snapshotSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
        }

        const snapshot = parsed.data as unknown as SchemaSnapshot;
        const prune = request.query.prune === 'true';
        const entries = diffSnapshot(snapshot, schemaManager.listObjects(), { prune });

        if (request.query.dryRun === 'true') {
          return { data: { changes: entries, changeCount: entries.length } };
        }

        const results = await applySnapshot(schemaManager, entries, {
          force: request.query.force === 'true',
        });
        const failed = results.filter((r) => !r.success);
        if (failed.length > 0) {
          return reply.code(422).send({
            error: 'Snapshot Partially Applied',
            data: { results, applied: results.length - failed.length, failed: failed.length },
          });
        }
        recordSchemaChange('apply_snapshot');
        return { data: { results, applied: results.length, failed: 0 } };
      },
    );

    // --- Drift doctor (Phase 10 / 4B) ---
    if (options.doctor) {
      const doctor = options.doctor;

      fastify.get('/doctor', async () => {
        return { data: await doctor.diagnose() };
      });

      // Adopt an unmanaged table (no column) or column into metadata.
      fastify.post('/doctor/adopt', async (request, reply) => {
        const body = z
          .object({ table: z.string().min(1), column: z.string().min(1).optional() })
          .safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'Validation Error', issues: body.error.issues });
        }

        const { table, column } = body.data;
        const result = column
          ? await schemaManager.adoptColumn(
              schemaManager.listObjects().find((o) => o.tableName === table)?.name ?? table,
              column,
            )
          : await schemaManager.adoptTable(table);

        if (!result.success) {
          return reply.code(422).send({ error: 'Adopt Failed', message: result.error });
        }
        recordSchemaChange('adopt', table);
        return { success: true, data: result };
      });

      // Persisted allowlist: silence / re-enable a finding.
      fastify.post('/doctor/ignore', async (request, reply) => {
        const body = z.object({ key: z.string().min(1) }).safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'Validation Error', issues: body.error.issues });
        }
        return { success: true, ignored: await doctor.ignore(body.data.key) };
      });

      fastify.post('/doctor/unignore', async (request, reply) => {
        const body = z.object({ key: z.string().min(1) }).safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'Validation Error', issues: body.error.issues });
        }
        return { success: true, ignored: await doctor.unignore(body.data.key) };
      });
    }

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
