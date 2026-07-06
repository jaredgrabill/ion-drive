/**
 * HTTP rate limiting for the core server.
 *
 * Ion Drive applies per-IP rate limiting via `@fastify/rate-limit`, registered
 * globally from `createServer` (config-gated by `ION_RATE_LIMIT_ENABLED`).
 * Two logical buckets share one window (`ION_RATE_LIMIT_WINDOW_MS`):
 *
 * - a generous global bucket (`ION_RATE_LIMIT_MAX`) for the API surface, and
 * - a stricter bucket (`ION_RATE_LIMIT_AUTH_MAX`) for the auth endpoints.
 *
 * Better Auth mounts as a single catch-all route at `/api/auth/*`, so
 * per-route `config.rateLimit` cannot target its individual endpoints.
 * Instead the plugin's `max` function (evaluated per request) returns the
 * stricter limit for auth URLs, and the `keyGenerator` namespaces auth hits
 * (`auth:<ip>`) so the two buckets count independently. `/health` and
 * `/metrics` (probes/scrapers) are exempt via the allowList. The 429 body
 * matches the flat `{ error, message }` envelope used by the API routes.
 */
import rateLimit, { type RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { IonDriveConfig } from '../config/index.js';

/** The slice of platform config the rate limiter consumes. */
export type RateLimitConfig = Pick<
  IonDriveConfig,
  'rateLimitEnabled' | 'rateLimitMax' | 'rateLimitWindowMs' | 'rateLimitAuthMax'
>;

/**
 * Registers `@fastify/rate-limit` on the server when enabled; logs a warning
 * when the limiter is switched off. Called from `createServer` right after
 * the other security plugins (CORS, helmet), before any routes are added.
 */
export async function installRateLimit(
  server: FastifyInstance,
  config: RateLimitConfig,
): Promise<void> {
  if (!config.rateLimitEnabled) {
    server.log.warn('HTTP rate limiting disabled (ION_RATE_LIMIT_ENABLED=false)');
    return;
  }
  await server.register(rateLimit, buildRateLimitOptions(config));
}

/** True for requests handled by the auth surface (`/api/auth/*`). */
function isAuthRequest(url: string): boolean {
  return url === '/api/auth' || url.startsWith('/api/auth/');
}

/**
 * Builds the `@fastify/rate-limit` plugin options from platform config.
 * See the module JSDoc for how the global and auth buckets interact.
 */
export function buildRateLimitOptions(config: RateLimitConfig): RateLimitPluginOptions {
  return {
    global: true,
    timeWindow: config.rateLimitWindowMs,
    max: (request, _key) =>
      isAuthRequest(request.url) ? config.rateLimitAuthMax : config.rateLimitMax,
    keyGenerator: (request) => (isAuthRequest(request.url) ? `auth:${request.ip}` : request.ip),
    allowList: (request) => request.url === '/health' || request.url === '/metrics',
    // The built response is *thrown* through Fastify's error handler, which
    // reads `statusCode` for the HTTP status and serialises the rest into the
    // standard flat `{ error, message }` envelope.
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      error: 'Too Many Requests',
      message: `Rate limit exceeded — retry in ${context.after}`,
    }),
  };
}
