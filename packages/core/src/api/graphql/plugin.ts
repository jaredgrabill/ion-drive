/**
 * GraphQL Fastify Plugin — serves the dynamic GraphQL surface via graphql-yoga.
 *
 * The schema is reflected from the runtime Schema Registry (see schema-builder).
 * Because objects change at runtime, we can't bake the schema in once: instead
 * we cache it by the registry's version number and rebuild lazily whenever the
 * schema changes. Yoga calls `schema` as a factory per request, so a freshly
 * created object is queryable immediately.
 *
 * Yoga reads the raw request stream, so within this encapsulated plugin scope
 * we register a passthrough content-type parser that stops Fastify from
 * consuming the JSON body first. That parser is scoped to this plugin only.
 */

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { GraphQLSchema } from 'graphql';
import { type Plugin as YogaPlugin, createYoga } from 'graphql-yoga';
import type { PermissionEngine } from '../../auth/rbac/permission-engine.js';
import type { RowPolicyResolver } from '../../auth/rbac/row-policy.js';
import type { ActionExecutor } from '../../blocks/action-executor.js';
import type { DataService } from '../../data/data-service.js';
import type { RealtimeBridge } from '../../messaging/realtime.js';
import type { SchemaRegistry } from '../../schema/schema-registry.js';
import { MAX_QUERY_DEPTH, createDepthLimitRule } from './depth-limit.js';
import { RelationLoader, type RelationLoaderContext } from './relation-loader.js';
import { type GraphQLSchemaExtras, buildGraphQLSchema } from './schema-builder.js';

export interface GraphQLRoutesOptions {
  registry: SchemaRegistry;
  dataService: DataService;
  /** Absolute path the GraphQL endpoint is served at. */
  endpoint?: string;
  /** Whether to serve the GraphiQL playground (default: true). */
  graphiql?: boolean;
  /** Enables block-action mutations (with `permissionEngine`). Phase 13. */
  actionExecutor?: ActionExecutor;
  /** Required for action mutations and subscriptions (per-event RBAC). */
  permissionEngine?: PermissionEngine;
  /** Whether RBAC is enforced (config.requireAuth). */
  enforce?: boolean;
  /** Enables `Subscription.events` when the outbox bus is live. Phase 13. */
  realtime?: RealtimeBridge;
  /** Row-level read scoping for subscription data events (issue #7). */
  rowPolicies?: RowPolicyResolver;
}

type YogaContext = { req: FastifyRequest; reply: FastifyReply };

/**
 * Shapes yoga's variadic log args for pino: a leading Error moves under the
 * `err` key (so pino's serializer expands stack/message), everything else
 * becomes the log message / extras.
 */
function toPinoArgs(args: unknown[]): Record<string, unknown> {
  const errIndex = args.findIndex((a) => a instanceof Error);
  if (errIndex === -1) return { graphql: args };
  const rest = args.filter((_, i) => i !== errIndex);
  return { err: args[errIndex], graphql: rest };
}

/**
 * How long the cached schema trusts its installed-action snapshot. A block
 * install usually bumps the registry version (its objects), which rebuilds
 * immediately; this TTL catches logic-only installs. Execution correctness
 * never depends on it — action resolution re-checks installed state per call.
 */
const ACTIONS_REFRESH_MS = 15_000;

/**
 * Builds a schema provider that rebuilds when the registry version changes,
 * and re-checks the installed-action fingerprint at most every
 * {@link ACTIONS_REFRESH_MS}.
 */
function createSchemaProvider(options: GraphQLRoutesOptions): () => Promise<GraphQLSchema> {
  const { registry, dataService, actionExecutor } = options;
  const extras: Omit<GraphQLSchemaExtras, 'declaredActions'> = {
    actionExecutor,
    permissionEngine: options.permissionEngine,
    enforce: options.enforce,
    realtime: options.realtime,
    rowPolicies: options.rowPolicies,
  };
  let cache: {
    version: number;
    fingerprint: string;
    checkedAt: number;
    schema: GraphQLSchema;
  } | null = null;

  return async () => {
    const version = registry.getVersion();
    const now = Date.now();
    const fresh = cache && now - cache.checkedAt < ACTIONS_REFRESH_MS;
    if (cache && cache.version === version && (fresh || !actionExecutor)) return cache.schema;

    const declaredActions = actionExecutor ? await actionExecutor.listDeclaredActions() : [];
    const fingerprint = declaredActions
      .map((a) => `${a.block}.${a.name}`)
      .sort()
      .join(',');
    if (cache && cache.version === version && cache.fingerprint === fingerprint) {
      cache.checkedAt = now;
      return cache.schema;
    }
    cache = {
      version,
      fingerprint,
      checkedAt: now,
      schema: buildGraphQLSchema(registry, dataService, { ...extras, declaredActions }),
    };
    return cache.schema;
  };
}

export function registerGraphQLRoutes(options: GraphQLRoutesOptions): FastifyPluginCallback {
  const { dataService } = options;
  const endpoint = options.endpoint ?? '/api/v1/graphql';
  const graphiql = options.graphiql ?? true;

  return (fastify, _opts, done) => {
    const getSchema = createSchemaProvider(options);

    // Reject cyclic-traversal abuse before execution (Phase 13 — the type
    // graph has relationship cycles now).
    const depthLimitPlugin: YogaPlugin = {
      onValidate({ addValidationRule }) {
        addValidationRule(createDepthLimitRule(MAX_QUERY_DEPTH));
      },
    };

    const yoga = createYoga<YogaContext, RelationLoaderContext>({
      schema: () => getSchema(),
      graphqlEndpoint: endpoint,
      graphiql,
      plugins: [depthLimitPlugin],
      // One relation loader per request: relation fields on sibling rows
      // batch into a single DataService fetch (see relation-loader.ts).
      context: () => ({ relationLoader: new RelationLoader(dataService) }),
      // Fastify owns logging; let it flow through the request logger.
      // Errors must land under pino's `err` key — a raw Error inside an array
      // serializes to `{}` and masked GraphQL errors become invisible in logs.
      logging: {
        debug: (...args) => fastify.log.debug(toPinoArgs(args)),
        info: (...args) => fastify.log.info(toPinoArgs(args)),
        warn: (...args) => fastify.log.warn(toPinoArgs(args)),
        error: (...args) => fastify.log.error(toPinoArgs(args)),
      },
    });

    // Stop Fastify from consuming the body so Yoga can read the raw stream.
    // Encapsulated to this plugin scope — other routes keep normal JSON parsing.
    fastify.addContentTypeParser('application/json', {}, (_req, _payload, next) => next(null));

    fastify.route({
      url: endpoint,
      method: ['GET', 'POST', 'OPTIONS'],
      handler: async (req, reply) => {
        const response = await yoga.handleNodeRequestAndResponse(req, reply, { req, reply });
        for (const [key, value] of response.headers) {
          reply.header(key, value);
        }
        reply.status(response.status);
        reply.send(response.body);
        return reply;
      },
    });

    done();
  };
}
