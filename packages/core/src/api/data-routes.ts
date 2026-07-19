/**
 * Dynamic REST Route Generator — CRUD endpoints for every data object.
 *
 * Ion Drive objects are defined at runtime, but Fastify cannot register new
 * routes after `server.listen()`. Rather than restart or re-register on every
 * schema change, we register a single set of **parameterized routes** and
 * resolve the target object from the Schema Registry on each request:
 *
 *   GET    /api/v1/data/:object          — List with filtering, sorting, pagination
 *   GET    /api/v1/data/:object/aggregate — count/sum/avg/min/max over the filtered rows
 *   POST   /api/v1/data/:object          — Create (`?on_conflict=col[,col2]` → upsert)
 *   POST   /api/v1/data/:object/bulk     — Bulk create
 *   DELETE /api/v1/data/:object/bulk     — Bulk delete
 *   GET    /api/v1/data/:object/:id       — Get by ID
 *   PATCH  /api/v1/data/:object/:id       — Update (numeric fields accept { "$inc": n })
 *   DELETE /api/v1/data/:object/:id       — Delete
 *   POST   /api/v1/data/:object/:id/links/:rel — Add many_to_many links
 *   DELETE /api/v1/data/:object/:id/links/:rel — Remove many_to_many links
 *
 * This means a newly created object's endpoints are live immediately — no
 * route re-registration, no restart. Fastify's router resolves the static
 * `/bulk` segment ahead of the `/:id` parameter, so the two never collide.
 *
 * See ADR-009 (Dynamic API surface via runtime reflection).
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply } from 'fastify';
import type { DataService } from '../data/data-service.js';
import { DataServiceError } from '../data/data-service.js';
import { parseAggregateParams, parseQueryParams } from '../data/query-parser.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import type { DataObjectDefinition } from '../schema/types.js';

export interface DataRoutesOptions {
  dataService: DataService;
  registry: SchemaRegistry;
}

/**
 * Creates a Fastify plugin that registers the dynamic CRUD surface.
 * Routes are parameterized by object name and resolved per request, so the
 * surface stays correct as objects are created and dropped at runtime.
 */
export function registerDataRoutes(options: DataRoutesOptions): FastifyPluginCallback {
  const { dataService, registry } = options;

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    /**
     * Resolves the requested object from the registry, or sends a 404.
     * Returns `null` when the object is missing or is an internal system
     * object (system objects are not exposed through the data API).
     */
    function resolveObject(name: string, reply: FastifyReply): DataObjectDefinition | null {
      const obj = registry.getObject(name);
      if (!obj || obj.isSystem) {
        reply.code(404).send({
          error: 'Not Found',
          message: `Data object "${name}" not found`,
        });
        return null;
      }
      return obj;
    }

    // --- Discovery — lists all available data endpoints ---
    fastify.get('/', async () => {
      const objects = registry.listObjects().filter((o) => !o.isSystem);
      return {
        data: objects.map((obj) => ({
          name: obj.name,
          displayName: obj.displayName,
          endpoints: {
            list: `GET /api/v1/data/${obj.name}`,
            aggregate: `GET /api/v1/data/${obj.name}/aggregate`,
            get: `GET /api/v1/data/${obj.name}/:id`,
            create: `POST /api/v1/data/${obj.name}`,
            update: `PATCH /api/v1/data/${obj.name}/:id`,
            delete: `DELETE /api/v1/data/${obj.name}/:id`,
            bulkCreate: `POST /api/v1/data/${obj.name}/bulk`,
            bulkDelete: `DELETE /api/v1/data/${obj.name}/bulk`,
          },
          fields: obj.fields
            .filter((f) => !f.isSystem)
            .map((f) => ({ name: f.name, type: f.columnType, required: f.isRequired ?? false })),
        })),
        count: objects.length,
      };
    });

    // --- LIST ---
    fastify.get<{ Params: { object: string } }>('/:object', async (request, reply) => {
      const obj = resolveObject(request.params.object, reply);
      if (!obj) return reply;
      try {
        const queryOptions = parseQueryParams(request.query as Record<string, unknown>);
        return await dataService.list(obj.name, queryOptions);
      } catch (err) {
        return handleError(err, reply);
      }
    });

    // --- AGGREGATE (issue #13) ---
    // Registered before `/:object/:id`; the static `aggregate` segment wins,
    // like `/bulk`. Same filter/search grammar (and RBAC read permission) as
    // the list endpoint; `fn`/`field` address the aggregate itself.
    fastify.get<{ Params: { object: string } }>('/:object/aggregate', async (request, reply) => {
      const obj = resolveObject(request.params.object, reply);
      if (!obj) return reply;
      try {
        const { fn, field, options } = parseAggregateParams(
          request.query as Record<string, unknown>,
        );
        if (!fn) {
          return reply.code(400).send({
            error: 'Validation Error',
            message: 'Missing required query parameter "fn" (one of: count, sum, avg, min, max)',
          });
        }
        const result = await dataService.aggregate(obj.name, fn, field, options);
        return { data: result };
      } catch (err) {
        return handleError(err, reply);
      }
    });

    // --- CREATE / UPSERT ---
    // `?on_conflict=<col>[,col2]` switches to upsert (issue #9): INSERT … ON
    // CONFLICT DO UPDATE against a declared unique target (an isUnique field,
    // the primary key, or a constraints.uniqueTogether group). 201 when the
    // row was inserted, 200 when an existing row was updated; the body gains
    // a `created` indicator beside the usual `data` envelope.
    fastify.post<{ Params: { object: string }; Querystring: { on_conflict?: string } }>(
      '/:object',
      async (request, reply) => {
        const obj = resolveObject(request.params.object, reply);
        if (!obj) return reply;
        try {
          const body = parseObjectBody(request.body, reply);
          if (!body) return reply;
          return await createOrUpsert(dataService, obj.name, body, request.query, reply);
        } catch (err) {
          return handleError(err, reply);
        }
      },
    );

    // --- BULK CREATE ---
    // Registered before `/:object/:id` so the static `bulk` segment wins.
    fastify.post<{ Params: { object: string } }>('/:object/bulk', async (request, reply) => {
      const obj = resolveObject(request.params.object, reply);
      if (!obj) return reply;
      try {
        const body = request.body as { data?: unknown[] } | undefined;
        if (!body?.data || !Array.isArray(body.data)) {
          return reply.code(400).send({
            error: 'Validation Error',
            message: 'Request body must contain a "data" array',
          });
        }
        const result = await dataService.bulkCreate(
          obj.name,
          body.data as Record<string, unknown>[],
        );
        return reply.code(201).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    });

    // --- BULK DELETE ---
    fastify.delete<{ Params: { object: string } }>('/:object/bulk', async (request, reply) => {
      const obj = resolveObject(request.params.object, reply);
      if (!obj) return reply;
      try {
        const body = request.body as { ids?: string[] } | undefined;
        if (!body?.ids || !Array.isArray(body.ids)) {
          return reply.code(400).send({
            error: 'Validation Error',
            message: 'Request body must contain an "ids" array',
          });
        }
        return await dataService.bulkDelete(obj.name, body.ids);
      } catch (err) {
        return handleError(err, reply);
      }
    });

    // --- GET BY ID ---
    fastify.get<{ Params: { object: string; id: string }; Querystring: { expand?: string } }>(
      '/:object/:id',
      async (request, reply) => {
        const obj = resolveObject(request.params.object, reply);
        if (!obj) return reply;
        try {
          const expand = request.query.expand
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const result = await dataService.getById(obj.name, request.params.id, { expand });
          if (!result) return sendRecordNotFound(reply, obj, request.params.id);
          return result;
        } catch (err) {
          return handleError(err, reply);
        }
      },
    );

    // --- UPDATE ---
    fastify.patch<{ Params: { object: string; id: string } }>(
      '/:object/:id',
      async (request, reply) => {
        const obj = resolveObject(request.params.object, reply);
        if (!obj) return reply;
        try {
          const body = parseObjectBody(request.body, reply);
          if (!body) return reply;
          const result = await dataService.update(obj.name, request.params.id, body);
          if (!result) return sendRecordNotFound(reply, obj, request.params.id);
          return result;
        } catch (err) {
          return handleError(err, reply);
        }
      },
    );

    // --- DELETE ---
    fastify.delete<{ Params: { object: string; id: string } }>(
      '/:object/:id',
      async (request, reply) => {
        const obj = resolveObject(request.params.object, reply);
        if (!obj) return reply;
        try {
          const deleted = await dataService.delete(obj.name, request.params.id);
          if (!deleted) return sendRecordNotFound(reply, obj, request.params.id);
          return reply.code(204).send();
        } catch (err) {
          return handleError(err, reply);
        }
      },
    );

    // --- LINK / UNLINK (many_to_many junction writes — Phase 13) ---
    // Body: { ids: [targetId, ...] }. Idempotent both ways; the response
    // reports how many links actually changed.
    fastify.post<{ Params: { object: string; id: string; rel: string } }>(
      '/:object/:id/links/:rel',
      async (request, reply) => {
        const obj = resolveObject(request.params.object, reply);
        if (!obj) return reply;
        const ids = parseIdsBody(request.body, reply);
        if (!ids) return reply;
        try {
          const result = await dataService.addLinks(
            obj.name,
            request.params.id,
            request.params.rel,
            ids,
          );
          return { data: result };
        } catch (err) {
          return handleError(err, reply);
        }
      },
    );

    fastify.delete<{ Params: { object: string; id: string; rel: string } }>(
      '/:object/:id/links/:rel',
      async (request, reply) => {
        const obj = resolveObject(request.params.object, reply);
        if (!obj) return reply;
        const ids = parseIdsBody(request.body, reply);
        if (!ids) return reply;
        try {
          const result = await dataService.removeLinks(
            obj.name,
            request.params.id,
            request.params.rel,
            ids,
          );
          return { data: result };
        } catch (err) {
          return handleError(err, reply);
        }
      },
    );

    done();
  };
}

/**
 * Validates that a write body is a JSON object. Returns it, or sends the 400
 * and returns null.
 */
function parseObjectBody(body: unknown, reply: FastifyReply): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reply.code(400).send({
      error: 'Validation Error',
      message: 'Request body must be a JSON object',
    });
    return null;
  }
  return body as Record<string, unknown>;
}

/** Parses the `on_conflict` query param into column names (undefined = plain create). */
function parseOnConflict(raw: string | undefined): string[] | undefined {
  const columns = raw
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return columns?.length ? columns : undefined;
}

/**
 * Runs a POST body as a plain create, or — when `on_conflict` names columns —
 * an upsert (issue #9). Upserts answer 201 when the row was inserted and 200
 * when an existing row was updated, with a `created` indicator in the body.
 */
async function createOrUpsert(
  dataService: DataService,
  objectName: string,
  body: Record<string, unknown>,
  query: { on_conflict?: string },
  reply: FastifyReply,
): Promise<FastifyReply> {
  const onConflict = parseOnConflict(query.on_conflict);
  if (onConflict) {
    const result = await dataService.upsert(objectName, body, onConflict);
    return reply.code(result.created ? 201 : 200).send(result);
  }
  const result = await dataService.create(objectName, body);
  return reply.code(201).send(result);
}

/**
 * Validates a link/unlink body (`{ ids: string[] }`). Returns the ids, or
 * sends the 400 and returns null.
 */
function parseIdsBody(body: unknown, reply: FastifyReply): string[] | null {
  const ids = (body as { ids?: unknown } | undefined)?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    reply.code(400).send({
      error: 'Validation Error',
      message: 'Request body must contain an "ids" array of record ids',
    });
    return null;
  }
  return ids as string[];
}

/**
 * Sends a consistent 404 for a missing record.
 */
function sendRecordNotFound(
  reply: FastifyReply,
  obj: DataObjectDefinition,
  id: string,
): FastifyReply {
  return reply.code(404).send({
    error: 'Not Found',
    message: `${obj.displayName} with ID "${id}" not found`,
  });
}

/**
 * Standard error handler for data routes. Known DataServiceErrors map to their
 * status codes (including the Postgres constraint translations from
 * `data/errors.ts` — 409 unique/foreign-key, 400 not-null/invalid-value —
 * with the offending `field` attached when it could be determined);
 * unexpected errors are re-thrown to Fastify's error handler.
 */
function handleError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof DataServiceError) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
      ...(err.field !== undefined ? { field: err.field } : {}),
    });
  }
  throw err;
}
