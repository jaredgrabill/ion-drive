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
import { createYoga } from 'graphql-yoga';
import type { DataService } from '../../data/data-service.js';
import type { SchemaRegistry } from '../../schema/schema-registry.js';
import { buildGraphQLSchema } from './schema-builder.js';

export interface GraphQLRoutesOptions {
  registry: SchemaRegistry;
  dataService: DataService;
  /** Absolute path the GraphQL endpoint is served at. */
  endpoint?: string;
  /** Whether to serve the GraphiQL playground (default: true). */
  graphiql?: boolean;
}

type YogaContext = { req: FastifyRequest; reply: FastifyReply };

/**
 * Builds a schema provider that rebuilds only when the registry version changes.
 */
function createSchemaProvider(
  registry: SchemaRegistry,
  dataService: DataService,
): () => GraphQLSchema {
  let cache: { version: number; schema: GraphQLSchema } | null = null;
  return () => {
    const version = registry.getVersion();
    if (!cache || cache.version !== version) {
      cache = { version, schema: buildGraphQLSchema(registry, dataService) };
    }
    return cache.schema;
  };
}

export function registerGraphQLRoutes(options: GraphQLRoutesOptions): FastifyPluginCallback {
  const { registry, dataService } = options;
  const endpoint = options.endpoint ?? '/api/v1/graphql';
  const graphiql = options.graphiql ?? true;

  return (fastify, _opts, done) => {
    const getSchema = createSchemaProvider(registry, dataService);

    const yoga = createYoga<YogaContext>({
      schema: () => getSchema(),
      graphqlEndpoint: endpoint,
      graphiql,
      // Fastify owns logging; let it flow through the request logger.
      logging: {
        debug: (...args) => fastify.log.debug(args),
        info: (...args) => fastify.log.info(args),
        warn: (...args) => fastify.log.warn(args),
        error: (...args) => fastify.log.error(args),
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
