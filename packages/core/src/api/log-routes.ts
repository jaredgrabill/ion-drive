/**
 * Logs API — queries the in-memory {@link LogBuffer} and streams live entries.
 *
 *  - `GET /`        — filtered query (level, source, search, since, limit, offset)
 *  - `GET /sources` — distinct sources for the filter dropdown
 *  - `GET /stream`  — Server-Sent Events tail: each new entry is one `data:` frame
 *
 * Registered under `/api/v1/logs`. Both endpoints are RBAC-guarded under the
 * `logs` resource with `read` permission (self-guarding, like admin routes).
 * The SSE stream writes directly to the raw socket — Fastify's reply
 * serialization is bypassed with `reply.hijack()` — and cleans its buffer
 * subscription up when the client disconnects.
 */

import type { FastifyInstance, FastifyPluginCallback, preHandlerHookHandler } from 'fastify';
import { requirePermission } from '../auth/rbac/middleware.js';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { Action } from '../auth/rbac/policy-types.js';
import { PLATFORM_RESOURCES } from '../auth/rbac/policy-types.js';
import type { LogBuffer, LogLevel } from '../telemetry/log-buffer.js';

export interface LogRoutesServices {
  logBuffer: LogBuffer;
  permissionEngine: PermissionEngine;
  /** When true, endpoints are protected by RBAC permissions. */
  enforce: boolean;
}

const RESOURCE = PLATFORM_RESOURCES.logs;
const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];
const SSE_HEARTBEAT_MS = 15_000;

interface LogsQuerystring {
  level?: string;
  source?: string;
  search?: string;
  since?: string;
  limit?: string;
  offset?: string;
}

export function registerLogRoutes(services: LogRoutesServices): FastifyPluginCallback {
  const { logBuffer, permissionEngine } = services;

  const guard = (action: Action): preHandlerHookHandler => {
    if (!services.enforce) return (_req, _reply, done) => done();
    return requirePermission(permissionEngine, action, RESOURCE);
  };

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // --- Query the buffer --------------------------------------------
    fastify.get<{ Querystring: LogsQuerystring }>(
      '/',
      { preHandler: guard('read') },
      async (request, reply) => {
        const { level, source, search, since, limit, offset } = request.query;
        if (level !== undefined && !LEVELS.includes(level as LogLevel)) {
          return reply.code(400).send({
            error: 'Validation Error',
            message: `level must be one of ${LEVELS.join(', ')}`,
          });
        }
        return logBuffer.query({
          level: level as LogLevel | undefined,
          source,
          search,
          since,
          limit: limit === undefined ? undefined : Number(limit),
          offset: offset === undefined ? undefined : Number(offset),
        });
      },
    );

    // --- Distinct sources (filter dropdown) ---------------------------
    fastify.get('/sources', { preHandler: guard('read') }, async () => ({
      data: logBuffer.sources(),
    }));

    // --- Live tail over Server-Sent Events ----------------------------
    fastify.get('/stream', { preHandler: guard('read') }, (request, reply) => {
      reply.hijack();
      const socket = reply.raw;
      socket.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      socket.write('retry: 3000\n\n');

      const unsubscribe = logBuffer.subscribe((entry) => {
        socket.write(`data: ${JSON.stringify(entry)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        socket.write(': heartbeat\n\n');
      }, SSE_HEARTBEAT_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.on('close', cleanup);
      socket.on('error', cleanup);
    });

    done();
  };
}
