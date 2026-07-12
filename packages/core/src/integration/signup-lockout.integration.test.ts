/**
 * Signup lockout integration suite (audit V5 + V4).
 *
 * Boots a real server with `ION_DISABLE_SIGNUP` on. After the first user
 * bootstraps as admin, public signup must be closed on **every** spelling of
 * the sign-up route that Better Auth's own router still dispatches — the outer
 * Fastify prefix check (`request.url.startsWith('/api/auth/sign-up')`) and
 * Better Auth's better-call router must not disagree, or a case/encoding
 * variant creates an account while dodging the 403 (V5). V4 additionally checks
 * that the lockout is durable: removing every role assignment must not re-open
 * public registration.
 *
 * Run with a reachable Postgres 17 (defaults match CI's service container).
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';
const SCRATCH_DB = `ion_signup_${randomBytes(6).toString('hex')}`;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

type Json = Record<string, unknown>;
type IonApp = Awaited<ReturnType<typeof createServer>>;

let adminClient: pg.Client | undefined;
let app: IonApp | undefined;

/** POSTs a signup body to an arbitrary (possibly mangled) auth path. */
async function signup(
  path: string,
  body: { email: string; password: string; name?: string },
): Promise<{ status: number; body: Json }> {
  if (!app) throw new Error('Server not booted');
  const res = await app.server.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  const parsed = res.body ? (JSON.parse(res.body) as Json) : {};
  return { status: res.statusCode, body: parsed };
}

/** Current count of accounts in Better Auth's user table. */
async function userCount(): Promise<number> {
  if (!app) throw new Error('Server not booted');
  const res = await app.server.inject({ method: 'GET', url: '/api/v1/users' });
  // Open server (no enforcement) — the list is readable directly.
  return (res.body ? ((JSON.parse(res.body) as Json).data as Json[]) : []).length;
}

beforeAll(async () => {
  adminClient = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5000 });
  try {
    await adminClient.connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Integration suite requires a reachable Postgres at ${ADMIN_URL}. Connection failed: ${reason}`,
    );
  }
  await adminClient.query(`CREATE DATABASE ${SCRATCH_DB}`);

  // Enforcement off (so we can read /api/v1/users without a session) but signup
  // lockout ON — the combination the lockout must hold under. allowOpen keeps
  // the (development) boot clean regardless of node env.
  app = await createServer({
    databaseUrl: scratchUrl(),
    requireAuth: false,
    allowOpen: true,
    disableSignup: true,
    nodeEnv: 'development',
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    logLevel: 'fatal',
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  // Wait for the scratch DB's sessions to drain before the FORCE drop, so it
  // never terminates a lingering pool socket (its 57P01 would surface as an
  // unhandled error). Mirrors platform.integration.test.ts.
  const started = Date.now();
  while (adminClient && Date.now() - started < 10_000) {
    const res = await adminClient.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [SCRATCH_DB],
    );
    if (res.rows[0].n === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await adminClient?.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await adminClient?.end();
}, 60_000);

describe('V5 — signup lockout cannot be bypassed by path mangling', () => {
  it('lets the first user bootstrap, then closes signup on every routable spelling', async () => {
    // 1. First signup succeeds and becomes admin (bootstrap window).
    const first = await signup('/api/auth/sign-up/email', {
      email: 'admin@ion.test',
      password: 'lockout-Passw0rd',
      name: 'Admin',
    });
    expect(first.status).toBe(200);
    expect(await userCount()).toBe(1);

    // 2. The canonical path is now blocked with a clean 403.
    const canonical = await signup('/api/auth/sign-up/email', {
      email: 'second@ion.test',
      password: 'lockout-Passw0rd',
    });
    expect(canonical.status).toBe(403);
    expect(await userCount()).toBe(1);

    // 3. Fuzz mangled spellings. For any variant Better Auth still ROUTES to
    //    signup (a 2xx), the lockout must have blocked it (403) — never a
    //    created account. Variants Better Auth doesn't route (404) are safe by
    //    non-existence. The invariant asserted for all: no new account.
    const variants = [
      '/api/auth/Sign-Up/email',
      '/api/auth/SIGN-UP/email',
      '/api/auth/sign-up/Email',
      '/api/auth/sign-up/email/',
      '/api/auth/sign-up//email',
      '/api/auth/%73ign-up/email', // %73 = 's'
      '/api/auth/sign-up/%65mail', // %65 = 'e'
      '/api/auth/./sign-up/email',
    ];
    for (const [i, path] of variants.entries()) {
      const res = await signup(path, {
        email: `bypass-${i}@ion.test`,
        password: 'lockout-Passw0rd',
      });
      // The account must never be created, regardless of status.
      expect(res.status, `variant ${path} created an account`).not.toBe(200);
      expect(await userCount(), `variant ${path} leaked an account`).toBe(1);
    }
  });
});

describe('V4 — signup lockout is durable across zero role assignments', () => {
  it('stays closed after every role assignment is removed', async () => {
    if (!app) throw new Error('Server not booted');
    const rm = app.roleManager;

    // The first admin from the V5 test still exists; remove their admin role so
    // the assignment count drops back to zero (migration to API-key-only access,
    // or an attacker with `manage` on roles).
    const admin = await rm.getByName('admin');
    expect(admin).toBeDefined();
    const adminId = (admin as { id: string }).id;
    const adminUsers = await rm.getUsersForRole(adminId);
    for (const userId of adminUsers) await rm.unassign(userId, adminId);
    expect(await rm.assignmentCount()).toBe(0);

    // Public signup must NOT re-open: the next signup would otherwise become
    // admin all over again. The durable bootstrap marker keeps it closed.
    const reopened = await signup('/api/auth/sign-up/email', {
      email: 'late-admin@ion.test',
      password: 'lockout-Passw0rd',
    });
    expect(reopened.status).toBe(403);
    expect(await userCount()).toBe(1);
  });
});
