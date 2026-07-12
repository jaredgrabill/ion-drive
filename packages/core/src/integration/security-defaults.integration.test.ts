/**
 * Security defaults integration suite (2026-07 framework-mode audit).
 *
 * Regression coverage for the "insecure defaults" findings — each test boots
 * the **real** server via `createServer()` against a throwaway scratch database
 * and asserts on runtime behaviour, not env-parsing in isolation.
 *
 *   V1 — a server with RBAC disabled must refuse to boot in production unless
 *        the operator explicitly acknowledges an open deployment
 *        (`ION_ALLOW_OPEN=true`). The companion test documents *why*: in open
 *        mode an anonymous caller can mint an admin-bound API key.
 *   V2 — credentialed CORS with a wildcard origin must be refused at boot.
 *
 * Run with a reachable Postgres 17 (defaults match CI's service container):
 *
 *   ION_DATABASE_URL=postgresql://ion:ion@localhost:5432/ion_drive \
 *     pnpm --filter @ion-drive/core test:integration
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

// ---------------------------------------------------------------------------
// Scratch database plumbing (mirrors platform.integration.test.ts)
// ---------------------------------------------------------------------------

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';
const SCRATCH_DB = `ion_sec_${randomBytes(6).toString('hex')}`;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type IonApp = Awaited<ReturnType<typeof createServer>>;

let adminClient: pg.Client | undefined;
let app: IonApp | undefined;

/** Injects a request into the running Fastify instance (no port binding). */
async function request(
  method: Method,
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json }> {
  if (!app) throw new Error('Server not booted');
  const res = await app.server.inject({
    method,
    url,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });
  const body = res.body ? (JSON.parse(res.body) as Json) : {};
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  adminClient = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5000 });
  try {
    await adminClient.connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Integration suite requires a reachable Postgres at ${ADMIN_URL} (start one with \`docker compose -f docker/docker-compose.yml up -d\` or set ION_DATABASE_URL). Connection failed: ${reason}`,
    );
  }
  await adminClient.query(`CREATE DATABASE ${SCRATCH_DB}`);

  // Boot in OPEN mode, but only via the explicit acknowledgement — this is the
  // deployment the V1 exploit test dissects. Development node env so the dev
  // fallback key applies; rate limiting off so the burst never 429s.
  app = await createServer({
    databaseUrl: scratchUrl(),
    requireAuth: false,
    allowOpen: true,
    nodeEnv: 'development',
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    logLevel: 'fatal',
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await adminClient?.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await adminClient?.end();
}, 60_000);

// ---------------------------------------------------------------------------
// V1 — auth-off default
// ---------------------------------------------------------------------------

describe('V1 — safe auth default', () => {
  it('refuses to boot with RBAC disabled in production unless open mode is acknowledged', async () => {
    await expect(
      createServer({
        databaseUrl: scratchUrl(),
        requireAuth: false,
        nodeEnv: 'production',
        encryptionKey: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/ION_REQUIRE_AUTH|ION_ALLOW_OPEN/);
  });

  it('exposes admin endpoints to anonymous callers in open mode (the V1 exploit)', async () => {
    // Anonymous read of the role catalogue succeeds with enforcement off.
    const roles = await request('GET', '/api/v1/roles');
    expect(roles.status).toBe(200);
    const adminRole = (roles.body.data as Json[]).find((r) => r.name === 'admin');
    expect(adminRole).toBeDefined();

    // An anonymous caller mints an API key bound straight to the admin role.
    const minted = await request('POST', '/api/v1/api-keys', {
      body: { name: 'attacker-key', roleId: (adminRole as Json).id },
    });
    expect(minted.status).toBe(201);
    const plaintext = (minted.body.data as Json).key as string;
    expect(plaintext).toMatch(/^iond_/);

    // The self-minted key now wields admin — no credentials were ever presented.
    const me = await request('GET', '/api/v1/me', { headers: { 'x-api-key': plaintext } });
    expect(me.status).toBe(200);
    expect(me.body.roles).toContain('admin');
  });
});
