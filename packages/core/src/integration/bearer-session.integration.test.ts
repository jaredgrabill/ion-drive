/**
 * Bearer-token session verification integration suite (issue #24).
 *
 * The use case: a game client signs in anonymously in the browser; its own
 * backend (e.g. a Cloudflare Worker) must verify that session server-side by
 * presenting the token from the sign-in response as `Authorization: Bearer` to
 * `GET /api/v1/me` — the browser cannot read the HttpOnly session cookie to
 * forward it. Boots a real server with anonymous auth + RBAC enforcement on
 * (the reporter's configuration) against a scratch Postgres and asserts:
 *
 *  1. the token returned by `POST /api/auth/sign-in/anonymous` verifies via
 *     `Authorization: Bearer <token>` on /api/v1/me — same identity and roles
 *     as the cookie session;
 *  2. the bearer header also works on Better Auth's own `/api/auth/*` surface
 *     (get-session);
 *  3. a bad / unknown token yields `{ authenticated: false }`, not an error;
 *  4. registered-user session tokens (email sign-up) verify the same way and
 *     resolve the same roles the cookie does;
 *  5. precedence with API keys is unambiguous: `Bearer iond_…` is routed to
 *     the API-key path by prefix (via: "api_key"), and an *invalid* `iond_`
 *     credential stays anonymous rather than being retried as a session token.
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';
const SCRATCH_DB = `ion_bearer_${randomBytes(6).toString('hex')}`;

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

/** State captured as the ordered tests progress. */
const state = {
  guestId: '',
  guestToken: '',
  guestCookie: '',
  adminId: '',
  adminToken: '',
  adminCookie: '',
  adminApiKey: '',
};

async function request(
  method: Method,
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json; cookies: { name: string; value: string }[] }> {
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
  return { status: res.statusCode, body, cookies: res.cookies };
}

/** GET /api/v1/me presenting only `Authorization: Bearer <credential>`. */
async function meWithBearer(credential: string) {
  return request('GET', '/api/v1/me', { headers: { authorization: `Bearer ${credential}` } });
}

/** Extracts the Better Auth session cookie from an inject response. */
function sessionCookie(cookies: { name: string; value: string }[]): string {
  const cookie = cookies.find((c) => c.name.includes('session_token'));
  if (!cookie) throw new Error('No session cookie in response');
  return `${cookie.name}=${cookie.value}`;
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

  // The reporter's configuration: anonymous auth ON + enforcement ON.
  app = await createServer({
    databaseUrl: scratchUrl(),
    anonymousAuth: true,
    requireAuth: true,
    publicUrl: 'http://bearer.ion.test',
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    nodeEnv: 'test',
    logLevel: 'fatal',
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  // Wait for the scratch DB's sessions to drain before the FORCE drop (see
  // platform.integration.test.ts for why).
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

describe('bearer-token session verification (integration)', () => {
  it('verifies an anonymous session via Authorization: Bearer on /api/v1/me', async () => {
    // The browser flow: sign in anonymously, hand the returned token to a
    // third-party server. The raw response body carries `{ token, user }`.
    const signIn = await request('POST', '/api/auth/sign-in/anonymous');
    expect(signIn.status).toBe(200);
    expect(typeof signIn.body.token).toBe('string');
    state.guestToken = signIn.body.token as string;
    state.guestId = (signIn.body.user as Json).id as string;
    state.guestCookie = sessionCookie(signIn.cookies);

    // The third-party server presents ONLY the bearer header — no cookie.
    const me = await meWithBearer(state.guestToken);
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.userId).toBe(state.guestId);
    expect(me.body.via).toBe('session');
    expect((me.body.user as Json).isAnonymous).toBe(true);

    // Identity and roles are exactly what the cookie session resolves.
    const viaCookie = await request('GET', '/api/v1/me', {
      headers: { cookie: state.guestCookie },
    });
    expect(me.body.userId).toBe(viaCookie.body.userId);
    expect(me.body.roles).toEqual(viaCookie.body.roles);
    expect(me.body.roles).toEqual(['anonymous']);
  });

  it('honors the bearer token on the /api/auth/* surface too', async () => {
    const session = await request('GET', '/api/auth/get-session', {
      headers: { authorization: `Bearer ${state.guestToken}` },
    });
    expect(session.status).toBe(200);
    expect((session.body.user as Json)?.id).toBe(state.guestId);
  });

  it('reports authenticated:false for a bad bearer token', async () => {
    const me = await meWithBearer('definitely-not-a-session-token');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ authenticated: false });
  });

  it('verifies registered-user tokens the same way — same identity, same roles', async () => {
    const signUp = await request('POST', '/api/auth/sign-up/email', {
      body: { email: 'admin@ion.test', password: 'bearer-Passw0rd!', name: 'Admin' },
    });
    expect(signUp.status).toBe(200);
    state.adminId = (signUp.body.user as Json).id as string;
    state.adminToken = signUp.body.token as string;
    state.adminCookie = sessionCookie(signUp.cookies);

    const viaBearer = await meWithBearer(state.adminToken);
    expect(viaBearer.body.authenticated).toBe(true);
    expect(viaBearer.body.userId).toBe(state.adminId);
    expect(viaBearer.body.via).toBe('session');
    expect(viaBearer.body.roles).toContain('admin');

    const viaCookie = await request('GET', '/api/v1/me', {
      headers: { cookie: state.adminCookie },
    });
    expect(viaBearer.body.roles).toEqual(viaCookie.body.roles);
  });

  it('keeps iond_ API keys on the API-key path — Bearer precedence is by prefix', async () => {
    const keyRes = await request('POST', '/api/v1/api-keys', {
      body: { name: 'bearer-suite', userId: state.adminId },
      headers: { cookie: state.adminCookie },
    });
    expect(keyRes.status).toBe(201);
    state.adminApiKey = (keyRes.body.data as Json).key as string;
    expect(state.adminApiKey.startsWith('iond_')).toBe(true);

    // A valid API key via Authorization: Bearer authenticates as an API key,
    // exactly as before the bearer plugin landed.
    const me = await meWithBearer(state.adminApiKey);
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.via).toBe('api_key');
    expect(me.body.userId).toBe(state.adminId);
    expect(me.body.roles).toContain('admin');

    // An invalid iond_ credential is an API-key miss, NOT a session-token
    // candidate: the request stays anonymous.
    const bogus = await meWithBearer('iond_0000000000000000000000000000000000000000');
    expect(bogus.status).toBe(200);
    expect(bogus.body).toEqual({ authenticated: false });
  });
});
