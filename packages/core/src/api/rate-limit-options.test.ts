/**
 * Tests for the rate-limit option builder: global vs auth buckets, the
 * health/metrics allowList, and the 429 error envelope. Exercises the real
 * options through `@fastify/rate-limit` on an injected Fastify instance.
 */
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRateLimitOptions } from './rate-limit-options.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(
    rateLimit,
    buildRateLimitOptions({
      rateLimitEnabled: true,
      rateLimitMax: 3,
      rateLimitWindowMs: 60_000,
      rateLimitAuthMax: 1,
    }),
  );
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/metrics', async () => 'metrics');
  app.get('/api/v1/ping', async () => ({ pong: true }));
  // Mirrors how Better Auth mounts: one catch-all route under /api/auth/*.
  app.all('/api/auth/*', async () => ({ auth: true }));
  return app;
}

describe('rate-limit options', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('enforces the global per-IP limit and returns the flat error envelope', async () => {
    app = await buildApp();
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/ping' });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: 'GET', url: '/api/v1/ping' });
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json();
    expect(body.error).toBe('Too Many Requests');
    expect(body.message).toContain('Rate limit exceeded');
  });

  it('applies the stricter auth limit to /api/auth/* without draining the global bucket', async () => {
    app = await buildApp();
    const first = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email' });
    expect(first.statusCode).toBe(200);
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email' });
    expect(blocked.statusCode).toBe(429);
    // The auth bucket is namespaced per IP, so the global bucket is untouched.
    const normal = await app.inject({ method: 'GET', url: '/api/v1/ping' });
    expect(normal.statusCode).toBe(200);
  });

  it('exempts /health and /metrics from rate limiting', async () => {
    app = await buildApp();
    for (let i = 0; i < 10; i++) {
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      const metrics = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.statusCode).toBe(200);
    }
  });
});
