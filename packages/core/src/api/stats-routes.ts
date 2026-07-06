/**
 * Stats API — dashboard snapshot, traffic charts, recent errors, and version.
 *
 * Backs the admin console's dashboard and metrics pages (Phase 8):
 *
 *  - `GET /stats`                 — platform snapshot (entity counts + 24h traffic)
 *  - `GET /stats/traffic?period=` — time-bucketed traffic from {@link TrafficStats}
 *  - `GET /stats/errors?limit=`   — recent 4xx/5xx responses
 *  - `GET /version`               — version, uptime, and feature flags
 *
 * Counts come from direct queries on the system tables; traffic comes from the
 * in-process aggregation fed by the request-tracing hook. Read endpoints are
 * guarded by the `stats` RBAC resource (self-guarding, like admin routes);
 * `/version` is unguarded — it powers the sidebar footer for any signed-in
 * user and exposes nothing sensitive (mirrors `/health`).
 */

import type { FastifyInstance, FastifyPluginCallback, preHandlerHookHandler } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { requirePermission } from '../auth/rbac/middleware.js';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { Action } from '../auth/rbac/policy-types.js';
import { PLATFORM_RESOURCES } from '../auth/rbac/policy-types.js';
import type { IonDriveConfig } from '../config/index.js';
import type { SystemDatabase } from '../db/types.js';
import type { SchemaManager } from '../schema/index.js';
import { type TrafficPeriod, trafficStats } from '../telemetry/traffic-stats.js';

export interface StatsRoutesServices {
  schemaManager: SchemaManager;
  systemDb: Kysely<SystemDatabase>;
  permissionEngine: PermissionEngine;
  config: IonDriveConfig;
  /** Platform version string (from the core package.json). */
  version: string;
  /** When true, endpoints are protected by RBAC permissions. */
  enforce: boolean;
}

const RESOURCE = PLATFORM_RESOURCES.stats;
const TRAFFIC_PERIODS: TrafficPeriod[] = ['1h', '6h', '24h', '7d'];

/** Counts rows in a table, returning 0 when the table doesn't exist yet. */
async function countTable(db: Kysely<SystemDatabase>, table: string): Promise<number> {
  try {
    const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql.table(
      table,
    )}`.execute(db);
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

export function registerStatsRoutes(services: StatsRoutesServices): FastifyPluginCallback {
  const { schemaManager, systemDb, permissionEngine, config, version } = services;
  const startedAt = Date.now();

  const guard = (action: Action): preHandlerHookHandler => {
    if (!services.enforce) return (_req, _reply, done) => done();
    return requirePermission(permissionEngine, action, RESOURCE);
  };

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // --- Platform snapshot -------------------------------------------
    fastify.get('/stats', { preHandler: guard('read') }, async () => {
      const objects = schemaManager.listObjects().filter((o) => !o.isSystem);
      const [users, roles, apiKeys, tasks, blocks] = await Promise.all([
        countTable(systemDb, 'user'),
        countTable(systemDb, '_ion_roles'),
        countTable(systemDb, '_ion_api_keys'),
        countTable(systemDb, '_ion_tasks'),
        countTable(systemDb, '_ion_blocks'),
      ]);
      const traffic = trafficStats.totals24h();
      return {
        data: {
          objects: objects.length,
          fields: objects.reduce((sum, o) => sum + o.fields.length, 0),
          users,
          roles,
          apiKeys,
          tasks,
          blocks,
          requests24h: traffic.requests,
          errors24h: traffic.errors,
        },
      };
    });

    // --- Time-bucketed traffic ---------------------------------------
    fastify.get<{ Querystring: { period?: string } }>(
      '/stats/traffic',
      { preHandler: guard('read') },
      async (request, reply) => {
        const period = (request.query.period ?? '24h') as TrafficPeriod;
        if (!TRAFFIC_PERIODS.includes(period)) {
          return reply.code(400).send({
            error: 'Validation Error',
            message: `period must be one of ${TRAFFIC_PERIODS.join(', ')}`,
          });
        }
        return { data: trafficStats.query(period) };
      },
    );

    // --- Recent error responses --------------------------------------
    fastify.get<{ Querystring: { limit?: string } }>(
      '/stats/errors',
      { preHandler: guard('read') },
      async (request) => {
        const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 100);
        return { data: trafficStats.errors(limit) };
      },
    );

    // --- Version + uptime + feature flags ----------------------------
    fastify.get('/version', async () => ({
      data: {
        name: 'Ion Drive',
        version,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        nodeVersion: process.version,
        features: {
          auth: config.requireAuth,
          tasks: config.tasksEnabled,
          blocks: config.blocksEnabled,
          events: config.eventsEnabled,
          metrics: config.metricsEnabled,
          otel: config.otelEnabled,
        },
      },
    }));

    done();
  };
}
