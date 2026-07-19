/**
 * Anonymous (guest) auth integration suite (issue #6).
 *
 * Boots a real server with `ION_ANONYMOUS_AUTH=true` + RBAC enforcement and
 * walks the whole guest lifecycle against a scratch Postgres:
 *
 *  1. a guest signs in anonymously BEFORE any real user exists — proving the
 *     guest neither becomes the bootstrap admin nor closes the bootstrap
 *     window (the seeded `anonymous` role is excluded from that accounting);
 *  2. the first email signup still becomes admin;
 *  3. the guest's access is governed by the editable `anonymous` role, and
 *     rows the guest creates carry the guest's id in `created_by`/`updated_by`;
 *  4. upgrade: signing up with email from the anonymous session creates a NEW
 *     user (Better Auth's documented model — the id is NOT preserved), the
 *     anonymous user is deleted, and Ion Drive's `onLinkAccount` migration
 *     carries roles + actor stamps to the new id, so no data orphans;
 *  5. the seeded TTL-cleanup task exists (disabled) and, when run, deletes
 *     stale never-upgraded guests only.
 *
 * The flag-OFF behaviour (endpoint 404s) is asserted in
 * platform.integration.test.ts, whose server boots with defaults.
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';
const SCRATCH_DB = `ion_anon_${randomBytes(6).toString('hex')}`;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type IonApp = Awaited<ReturnType<typeof createServer>>;

let adminClient: pg.Client | undefined;
let scratchClient: pg.Client | undefined;
let app: IonApp | undefined;

/** State captured as the ordered tests progress. */
const state = {
  guestCookie: '',
  guestId: '',
  adminCookie: '',
  adminApiKey: '',
  upgradedCookie: '',
  upgradedId: '',
  scoreRowId: '',
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

/** Authenticated with the admin API key minted during bootstrap. */
async function api(method: Method, url: string, body?: unknown) {
  return request(method, url, { body, headers: { 'x-api-key': state.adminApiKey } });
}

/** Extracts the Better Auth session cookie from an inject response. */
function sessionCookie(cookies: { name: string; value: string }[]): string {
  const cookie = cookies.find((c) => c.name.includes('session_token'));
  if (!cookie) throw new Error('No session cookie in response');
  return `${cookie.name}=${cookie.value}`;
}

async function dbRows<T extends Json>(text: string, values: unknown[] = []): Promise<T[]> {
  if (!scratchClient) throw new Error('No scratch client');
  const res = await scratchClient.query(text, values);
  return res.rows as T[];
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

  // Anonymous auth ON + enforcement ON — the security-relevant combination.
  app = await createServer({
    databaseUrl: scratchUrl(),
    anonymousAuth: true,
    requireAuth: true,
    publicUrl: 'http://guest.ion.test',
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    nodeEnv: 'test',
    logLevel: 'fatal',
  });

  scratchClient = new pg.Client({ connectionString: scratchUrl() });
  await scratchClient.connect();
}, 120_000);

afterAll(async () => {
  await scratchClient?.end();
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

describe('anonymous auth lifecycle (integration)', () => {
  it('signs in a guest before any real user exists — flagged, roled, not admin', async () => {
    const res = await request('POST', '/api/auth/sign-in/anonymous');
    expect(res.status).toBe(200);
    const user = res.body.user as Json;
    expect(typeof user?.id).toBe('string');
    state.guestId = user.id as string;
    state.guestCookie = sessionCookie(res.cookies);

    // Flagged in the database (column created by the boot migration runner).
    const rows = await dbRows<{ isAnonymous: boolean; email: string }>(
      'SELECT "isAnonymous", email FROM "user" WHERE id = $1',
      [state.guestId],
    );
    expect(rows[0]?.isAnonymous).toBe(true);
    // emailDomainName derived from publicUrl.
    expect(rows[0]?.email).toMatch(/@guest\.ion\.test$/);

    // The guest got the seeded `anonymous` role — and ONLY that role.
    const me = await request('GET', '/api/v1/me', {
      headers: { cookie: state.guestCookie },
    });
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect((me.body.user as Json).isAnonymous).toBe(true);
    expect(me.body.roles).toEqual(['anonymous']);

    // The anonymous role has no grants by default: platform surfaces refuse.
    const schema = await request('GET', '/api/v1/schema/objects', {
      headers: { cookie: state.guestCookie },
    });
    expect(schema.status).toBe(403);
  });

  it('still grants admin to the first email signup (guest did not close bootstrap)', async () => {
    const signup = await request('POST', '/api/auth/sign-up/email', {
      body: { email: 'admin@ion.test', password: 'anon-Passw0rd!', name: 'Admin' },
    });
    expect(signup.status).toBe(200);
    const adminId = (signup.body.user as Json).id as string;
    state.adminCookie = sessionCookie(signup.cookies);

    const keyRes = await request('POST', '/api/v1/api-keys', {
      body: { name: 'anon-suite', userId: adminId },
      headers: { cookie: state.adminCookie },
    });
    expect(keyRes.status).toBe(201);
    state.adminApiKey = (keyRes.body.data as Json).key as string;

    const me = await api('GET', '/api/v1/me');
    expect(me.body.roles).toContain('admin');
  });

  it('lets admins grant the anonymous role data access; guest writes carry the guest actor id', async () => {
    // Admin creates a data object for guests to write to.
    const created = await api('POST', '/api/v1/schema/objects', {
      name: 'guest_scores',
      displayName: 'Guest Scores',
      fields: [{ name: 'points', displayName: 'Points', columnType: 'integer' }],
    });
    expect(created.status).toBe(201);

    // Guests can't touch it yet (no grants on the anonymous role).
    const denied = await request('POST', '/api/v1/data/guest_scores', {
      body: { points: 1 },
      headers: { cookie: state.guestCookie },
    });
    expect(denied.status).toBe(403);

    // Admin edits the anonymous role like any other role.
    const roles = await api('GET', '/api/v1/roles');
    const anonRole = (roles.body.data as Json[]).find((r) => r.name === 'anonymous') as Json;
    expect(anonRole).toBeDefined();
    const patched = await api('PATCH', `/api/v1/roles/${anonRole.id}`, {
      permissions: [{ resource: 'guest_scores', actions: ['create', 'read'] }],
    });
    expect(patched.status).toBe(200);

    // Now the guest can create — and the row is stamped with the guest's id.
    const row = await request('POST', '/api/v1/data/guest_scores', {
      body: { points: 42 },
      headers: { cookie: state.guestCookie },
    });
    expect(row.status).toBe(201);
    const data = row.body.data as Json;
    state.scoreRowId = data.id as string;
    expect(data.created_by).toBe(state.guestId);
    expect(data.updated_by).toBe(state.guestId);
  });

  it('upgrades the guest via email signup: new id, old user deleted, data + roles migrated', async () => {
    // Give the guest an explicit role too — it must survive the upgrade.
    const roles = await api('GET', '/api/v1/roles');
    const editor = (roles.body.data as Json[]).find((r) => r.name === 'editor') as Json;
    const assigned = await api('POST', `/api/v1/roles/${editor.id}/assignments`, {
      userId: state.guestId,
    });
    expect([200, 201, 204]).toContain(assigned.status);

    // Sign up with a real credential FROM the anonymous session.
    const upgrade = await request('POST', '/api/auth/sign-up/email', {
      body: { email: 'player@ion.test', password: 'anon-Passw0rd!', name: 'Player One' },
      headers: { cookie: state.guestCookie },
    });
    expect(upgrade.status).toBe(200);
    state.upgradedId = (upgrade.body.user as Json).id as string;
    state.upgradedCookie = sessionCookie(upgrade.cookies);

    // Better Auth's semantics: a NEW user id (not preserved)…
    expect(state.upgradedId).not.toBe(state.guestId);
    // …and the anonymous user row is deleted after the link.
    const oldUser = await dbRows('SELECT id FROM "user" WHERE id = $1', [state.guestId]);
    expect(oldUser).toHaveLength(0);
    const newUser = await dbRows<{ isAnonymous: boolean | null }>(
      'SELECT "isAnonymous" FROM "user" WHERE id = $1',
      [state.upgradedId],
    );
    expect(newUser).toHaveLength(1);
    expect(newUser[0]?.isAnonymous ?? false).toBe(false);

    // Continuity — actor stamps on the guest's rows now point at the new id.
    const row = await api('GET', `/api/v1/data/guest_scores/${state.scoreRowId}`);
    expect(row.status).toBe(200);
    expect((row.body.data as Json).created_by).toBe(state.upgradedId);
    expect((row.body.data as Json).updated_by).toBe(state.upgradedId);

    // Continuity — explicit roles carried, `anonymous` dropped, nothing left
    // bound to the deleted id.
    const me = await request('GET', '/api/v1/me', {
      headers: { cookie: state.upgradedCookie },
    });
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(state.upgradedId);
    expect(me.body.roles).toContain('editor');
    expect(me.body.roles).not.toContain('anonymous');
    const orphaned = await dbRows('SELECT * FROM _ion_user_roles WHERE user_id = $1', [
      state.guestId,
    ]);
    expect(orphaned).toHaveLength(0);
  });

  it('seeds the TTL cleanup task disabled; running it deletes only stale guests', async () => {
    const tasks = await api('GET', '/api/v1/tasks');
    expect(tasks.status).toBe(200);
    const cleanup = (tasks.body.data as Json[]).find(
      (t) => t.name === 'anonymous-user-cleanup',
    ) as Json;
    expect(cleanup).toBeDefined();
    expect(cleanup.enabled).toBe(false);
    expect(cleanup.type).toBe('anonymous_cleanup');

    // Mint two fresh guests; backdate one beyond the TTL.
    const staleGuest = await request('POST', '/api/auth/sign-in/anonymous');
    const freshGuest = await request('POST', '/api/auth/sign-in/anonymous');
    const staleId = (staleGuest.body.user as Json).id as string;
    const freshId = (freshGuest.body.user as Json).id as string;
    await scratchClient?.query(
      `UPDATE "user" SET "createdAt" = now() - interval '60 days' WHERE id = $1`,
      [staleId],
    );

    // Run the (still-disabled) task on demand — disabled only gates the cron.
    const run = await api('POST', `/api/v1/tasks/${cleanup.id}/run`);
    expect(run.status).toBe(202);
    expect((run.body.data as Json).status).toBe('success');

    const survivors = await dbRows<{ id: string }>(
      'SELECT id FROM "user" WHERE id = ANY($1::text[])',
      [[staleId, freshId]],
    );
    expect(survivors.map((r) => r.id)).toEqual([freshId]);
    // The stale guest's session and role assignment are gone too.
    const sessions = await dbRows('SELECT id FROM "session" WHERE "userId" = $1', [staleId]);
    expect(sessions).toHaveLength(0);
    const assignments = await dbRows('SELECT * FROM _ion_user_roles WHERE user_id = $1', [staleId]);
    expect(assignments).toHaveLength(0);
  });
});
