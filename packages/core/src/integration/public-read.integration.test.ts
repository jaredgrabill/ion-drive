/**
 * Public read access integration suite (issue #8 — the built-in `public` role).
 *
 * Boots the real server via `createServer()` with `requireAuth: true` against a
 * throwaway scratch database (like `aggregate.integration.test.ts`) and drives
 * the whole feature end-to-end over real SQL:
 *
 *   1. bootstrap (first signup → admin → API key) + seeded `pub_players` /
 *      `pub_teams` objects with a many_to_one relationship
 *   2. the seeded `public` role: listed by the roles API, system-flagged, empty
 *   3. anonymous requests are 401 everywhere before any grant exists
 *   4. the safety rails, via the actual roles API: write/wildcard/platform
 *      grants → 400, rename → 400, delete → 409, user assignment → 400,
 *      API-key binding → 400, creating a second `public` → 400
 *   5. after granting read on `pub_players` as an admin: anonymous list,
 *      get-by-id, and aggregate → 200; ungranted object → 401; anonymous
 *      writes → 401; `expand=` honored only when the target is granted too
 *   6. GraphQL parity: anonymous granted query works, ungranted query and all
 *      mutations error, relation traversal requires the target grant
 *   7. MCP parity: anonymous clients get only the gated read tools
 *   8. admin routes stay 401 for anonymous callers regardless of grants
 *   9. ION_PUBLIC_ROLE=false hard-disables anonymous evaluation
 *
 * Run with a reachable Postgres 17:
 *
 *   ION_DATABASE_URL=postgresql://ion:ion@localhost:5432/ion_drive \
 *     pnpm --filter @ion-drive/core test:integration
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

// ---------------------------------------------------------------------------
// Scratch database plumbing
// ---------------------------------------------------------------------------

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';
const SCRATCH_DB = `ion_it_${randomBytes(6).toString('hex')}`;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

type IonApp = Awaited<ReturnType<typeof createServer>>;

let adminClient: pg.Client | undefined;
let app: IonApp | undefined;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const auth = { cookie: '', userId: '', apiKey: '' };
const state = { publicRoleId: '', teamId: '', playerId: '' };

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

/** Authenticated (admin API key) request. */
async function api(method: Method, url: string, body?: unknown) {
  return request(method, url, { body, headers: { 'x-api-key': auth.apiKey } });
}

/** Anonymous request — no credential of any kind. */
async function anon(method: Method, url: string, body?: unknown) {
  return request(method, url, { body });
}

/** Anonymous GraphQL operation; returns the full response body. */
async function anonGraphql(query: string): Promise<{ status: number; body: Json }> {
  return anon('POST', '/api/v1/graphql', { query });
}

/** One stateless anonymous MCP JSON-RPC exchange. */
async function anonMcp(payload: Json): Promise<{ status: number; body: Json }> {
  if (!app) throw new Error('Server not booted');
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, ...payload }),
  });
  const body = res.body ? (JSON.parse(res.body) as Json) : {};
  return { status: res.statusCode, body };
}

/** PATCHes the public role's permission set as the admin. */
async function setPublicGrants(permissions: { resource: string; actions: string[] }[]) {
  return api('PATCH', `/api/v1/roles/${state.publicRoleId}`, { permissions });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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

  app = await createServer({
    databaseUrl: scratchUrl(),
    requireAuth: true,
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    nodeEnv: 'test',
    logLevel: 'fatal',
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  // Wait for the pools' Terminate packets to land before dropping (see the
  // explanation in platform.integration.test.ts).
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await adminClient?.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [SCRATCH_DB],
    );
    if (res?.rows[0].n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await adminClient?.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await adminClient?.end();
}, 60_000);

// ---------------------------------------------------------------------------
// The suite (tests run in order and share state)
// ---------------------------------------------------------------------------

describe('public read access (integration)', () => {
  it('bootstraps auth and seeds players + teams with a relationship', async () => {
    if (!app) throw new Error('Server not booted');
    const signup = await app.server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'public@ion.test',
        password: 'integration-Passw0rd',
        name: 'Public Admin',
      }),
    });
    expect(signup.statusCode).toBe(200);
    const user = (JSON.parse(signup.body) as Json).user as Json;
    auth.userId = user.id as string;
    const sessionCookie = signup.cookies.find((c) => c.name.includes('session_token'));
    auth.cookie = `${sessionCookie?.name}=${sessionCookie?.value}`;

    const keyRes = await request('POST', '/api/v1/api-keys', {
      body: { name: 'public-suite', userId: auth.userId },
      headers: { cookie: auth.cookie },
    });
    expect(keyRes.status).toBe(201);
    auth.apiKey = (keyRes.body.data as Json).key as string;

    for (const [name, displayName, fields] of [
      [
        'pub_teams',
        'Pub Teams',
        [{ name: 'name', displayName: 'Name', columnType: 'text', isRequired: true }],
      ],
      [
        'pub_players',
        'Pub Players',
        [
          { name: 'name', displayName: 'Name', columnType: 'text', isRequired: true },
          { name: 'wins', displayName: 'Wins', columnType: 'integer' },
        ],
      ],
    ] as const) {
      const created = await api('POST', '/api/v1/schema/objects', {
        name,
        displayName,
        fields,
      });
      expect(created.status).toBe(201);
    }

    const rel = await api('POST', '/api/v1/schema/relationships', {
      name: 'team',
      displayName: 'Team',
      type: 'many_to_one',
      sourceObjectName: 'pub_players',
      targetObjectName: 'pub_teams',
    });
    expect(rel.status).toBe(201);

    const team = await api('POST', '/api/v1/data/pub_teams', { name: 'Alpha Squad' });
    expect(team.status).toBe(201);
    state.teamId = (team.body.data as Json).id as string;

    const seeded = await api('POST', '/api/v1/data/pub_players/bulk', {
      data: [
        { name: 'Ada', wins: 50, team_id: state.teamId },
        { name: 'Grace', wins: 42, team_id: state.teamId },
        { name: 'Alan', wins: 7 },
      ],
    });
    expect(seeded.status).toBe(201);
    const first = await api('GET', '/api/v1/data/pub_players?q=ada');
    state.playerId = ((first.body.data as Json[])[0] as Json).id as string;
  });

  it('seeds the public role: listed, system-flagged, empty', async () => {
    const roles = await api('GET', '/api/v1/roles');
    expect(roles.status).toBe(200);
    const names = (roles.body.data as Json[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['admin', 'editor', 'viewer', 'public']));
    const publicRole = (roles.body.data as Json[]).find((r) => r.name === 'public') as Json;
    expect(publicRole.is_system).toBe(true);
    expect(publicRole.permissions).toEqual([]);
    state.publicRoleId = publicRole.id as string;
  });

  it('401s anonymous requests everywhere while the role is empty', async () => {
    expect((await anon('GET', '/api/v1/data/pub_players')).status).toBe(401);
    expect((await anon('GET', `/api/v1/data/pub_players/${state.playerId}`)).status).toBe(401);
    expect((await anon('GET', '/api/v1/data/pub_players/aggregate?fn=count')).status).toBe(401);
    expect((await anonGraphql('{ pub_players { data { id } } }')).status).toBe(401);
    expect((await anonMcp({ method: 'tools/list' })).status).toBe(401);
  });

  it('enforces the safety rails on the roles API (400s)', async () => {
    // Write actions can never be granted to the public role.
    for (const actions of [['read', 'update'], ['create'], ['manage']]) {
      const res = await setPublicGrants([{ resource: 'pub_players', actions }]);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/only hold "read" grants/);
    }
    // The `*` action never reaches the rail — the request schema rejects it.
    expect((await setPublicGrants([{ resource: 'pub_players', actions: ['*'] }])).status).toBe(400);
    // Neither can the wildcard resource or platform resources.
    const wildcard = await setPublicGrants([{ resource: '*', actions: ['read'] }]);
    expect(wildcard.status).toBe(400);
    for (const resource of ['secrets', 'schema', 'roles', 'data']) {
      expect((await setPublicGrants([{ resource, actions: ['read'] }])).status).toBe(400);
    }

    // No rename, no delete, no user assignment, no API-key binding.
    const rename = await api('PATCH', `/api/v1/roles/${state.publicRoleId}`, { name: 'open' });
    expect(rename.status).toBe(400);
    expect((await api('DELETE', `/api/v1/roles/${state.publicRoleId}`)).status).toBe(409);
    const assign = await api('POST', `/api/v1/roles/${state.publicRoleId}/assignments`, {
      userId: auth.userId,
    });
    expect(assign.status).toBe(400);
    expect(assign.body.message).toMatch(/cannot be assigned/);
    const key = await api('POST', '/api/v1/api-keys', {
      name: 'public-bound',
      roleId: state.publicRoleId,
    });
    expect(key.status).toBe(400);

    // The name is reserved.
    const clone = await api('POST', '/api/v1/roles', { name: 'public', permissions: [] });
    expect(clone.status).toBe(400);
  });

  it('grants read on pub_players via the roles API', async () => {
    const res = await setPublicGrants([{ resource: 'pub_players', actions: ['read'] }]);
    expect(res.status).toBe(200);
    expect((res.body.data as Json).permissions).toEqual([
      { resource: 'pub_players', actions: ['read'] },
    ]);
  });

  it('serves anonymous list, get-by-id, and aggregate on the granted object', async () => {
    const list = await anon('GET', '/api/v1/data/pub_players?sort=-wins&pageSize=100');
    expect(list.status).toBe(200);
    expect((list.body.data as Json[]).length).toBe(3);
    expect(((list.body.data as Json[])[0] as Json).name).toBe('Ada');

    const single = await anon('GET', `/api/v1/data/pub_players/${state.playerId}`);
    expect(single.status).toBe(200);
    expect((single.body.data as Json).name).toBe('Ada');

    // The rank pattern from the issue: count of players ahead + 1.
    const agg = await anon('GET', '/api/v1/data/pub_players/aggregate?fn=count&wins[gt]=42');
    expect(agg.status).toBe(200);
    expect((agg.body.data as Json).filteredCount).toBe(1);
  });

  it('keeps ungranted objects 401 for anonymous callers', async () => {
    expect((await anon('GET', '/api/v1/data/pub_teams')).status).toBe(401);
    expect((await anon('GET', '/api/v1/data/pub_teams/aggregate?fn=count')).status).toBe(401);
    // The discovery route needs the `data` platform resource — ungrantable.
    expect((await anon('GET', '/api/v1/data')).status).toBe(401);
    // Schema surface stays closed too.
    expect((await anon('GET', '/api/v1/schema/objects')).status).toBe(401);
  });

  it('401s anonymous writes on the granted object regardless of grants', async () => {
    expect((await anon('POST', '/api/v1/data/pub_players', { name: 'Mallory' })).status).toBe(401);
    expect(
      (await anon('PATCH', `/api/v1/data/pub_players/${state.playerId}`, { wins: 999 })).status,
    ).toBe(401);
    expect((await anon('DELETE', `/api/v1/data/pub_players/${state.playerId}`)).status).toBe(401);
    expect(
      (await anon('POST', '/api/v1/data/pub_players/bulk', { data: [{ name: 'X' }] })).status,
    ).toBe(401);
    // Nothing was written.
    const count = await anon('GET', '/api/v1/data/pub_players/aggregate?fn=count');
    expect((count.body.data as Json).filteredCount).toBe(3);
  });

  it('honors expand= only when the target object is granted too', async () => {
    const denied = await anon('GET', `/api/v1/data/pub_players/${state.playerId}?expand=team`);
    expect(denied.status).toBe(401);

    const granted = await setPublicGrants([
      { resource: 'pub_players', actions: ['read'] },
      { resource: 'pub_teams', actions: ['read'] },
    ]);
    expect(granted.status).toBe(200);
    const expanded = await anon('GET', `/api/v1/data/pub_players/${state.playerId}?expand=team`);
    expect(expanded.status).toBe(200);
    expect(((expanded.body.data as Json).team as Json).name).toBe('Alpha Squad');

    // Revocation applies immediately.
    await setPublicGrants([{ resource: 'pub_players', actions: ['read'] }]);
    expect(
      (await anon('GET', `/api/v1/data/pub_players/${state.playerId}?expand=team`)).status,
    ).toBe(401);
    expect((await anon('GET', '/api/v1/data/pub_teams')).status).toBe(401);
  });

  it('serves anonymous GraphQL queries on the granted object only (parity)', async () => {
    const list = await anonGraphql(
      '{ pub_players(sort: [{ field: "wins", direction: desc }]) { data { id name wins } pagination { totalCount } } }',
    );
    expect(list.status).toBe(200);
    const payload = (list.body.data as Json).pub_players as Json;
    expect((payload.pagination as Json).totalCount).toBe(3);
    expect(((payload.data as Json[])[0] as Json).name).toBe('Ada');

    const byId = await anonGraphql(`{ pub_players_by_id(id: "${state.playerId}") { name } }`);
    expect((byId.body.data as Json).pub_players_by_id).toMatchObject({ name: 'Ada' });

    const agg = await anonGraphql(
      '{ pub_players_aggregate(fn: count, filter: [{ field: "wins", operator: gt, value: 42 }]) { filteredCount } }',
    );
    expect((agg.body.data as Json).pub_players_aggregate).toMatchObject({ filteredCount: 1 });

    // Ungranted object errors; so does relation traversal into it.
    const teams = await anonGraphql('{ pub_teams { data { id } } }');
    expect(JSON.stringify(teams.body.errors)).toMatch(/Missing permission: read on .*pub_teams/);
    const traversal = await anonGraphql('{ pub_players { data { name team { name } } } }');
    expect(JSON.stringify(traversal.body.errors)).toMatch(
      /Missing permission: read on .*pub_teams/,
    );
  });

  it('rejects anonymous GraphQL mutations', async () => {
    const create = await anonGraphql(
      'mutation { create_pub_players(input: { name: "Mallory" }) { id } }',
    );
    expect(JSON.stringify(create.body.errors)).toMatch(/Authentication required/);
    const del = await anonGraphql(`mutation { delete_pub_players(id: "${state.playerId}") }`);
    expect(JSON.stringify(del.body.errors)).toMatch(/Authentication required/);
    // Nothing was written.
    const count = await anon('GET', '/api/v1/data/pub_players/aggregate?fn=count');
    expect((count.body.data as Json).filteredCount).toBe(3);
  });

  it('gives anonymous MCP clients only the gated read tools (parity)', async () => {
    const tools = await anonMcp({ method: 'tools/list' });
    expect(tools.status).toBe(200);
    const names = ((tools.body.result as Json).tools as Json[]).map((t) => t.name).sort();
    expect(names).toEqual(['aggregate_data', 'get_record', 'query_data']);

    const granted = await anonMcp({
      method: 'tools/call',
      params: { name: 'query_data', arguments: { object_name: 'pub_players' } },
    });
    const grantedResult = granted.body.result as Json;
    expect(grantedResult.isError).toBeFalsy();
    expect(JSON.stringify(grantedResult.content)).toContain('Ada');

    const denied = await anonMcp({
      method: 'tools/call',
      params: { name: 'query_data', arguments: { object_name: 'pub_teams' } },
    });
    const deniedResult = denied.body.result as Json;
    expect(deniedResult.isError).toBe(true);
    expect(JSON.stringify(deniedResult.content)).toMatch(/read on \\"pub_teams\\"/);

    // Expand targets are gated like REST.
    const expandDenied = await anonMcp({
      method: 'tools/call',
      params: {
        name: 'query_data',
        arguments: { object_name: 'pub_players', expand: ['team'] },
      },
    });
    expect((expandDenied.body.result as Json).isError).toBe(true);

    // Write/schema tools are not even registered for anonymous clients.
    const write = await anonMcp({
      method: 'tools/call',
      params: {
        name: 'create_record',
        arguments: { object_name: 'pub_players', data: { name: 'Mallory' } },
      },
    });
    expect(JSON.stringify(write.body)).toMatch(/not found|unknown tool/i);
  });

  it('keeps admin routes 401 for anonymous callers regardless of grants', async () => {
    for (const url of [
      '/api/v1/roles',
      '/api/v1/users',
      '/api/v1/secrets',
      '/api/v1/config',
      '/api/v1/api-keys',
      '/api/v1/tasks',
    ]) {
      expect((await anon('GET', url)).status, url).toBe(401);
    }
    // And the authenticated read union never grants writes: the public grant
    // adds read-only access for logged-in users too, nothing more.
    const viewerCheck = await api('GET', '/api/v1/data/pub_players');
    expect(viewerCheck.status).toBe(200);
  });

  it('hard-disables anonymous evaluation with ION_PUBLIC_ROLE=false', async () => {
    const closed = await createServer({
      databaseUrl: scratchUrl(),
      requireAuth: true,
      publicRole: false,
      rateLimitEnabled: false,
      otelEnabled: false,
      metricsEnabled: false,
      nodeEnv: 'test',
      logLevel: 'fatal',
    });
    try {
      const res = await closed.server.inject({ method: 'GET', url: '/api/v1/data/pub_players' });
      expect(res.statusCode).toBe(401);
    } finally {
      await closed.close();
    }
  }, 60_000);
});
