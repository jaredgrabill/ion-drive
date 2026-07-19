/**
 * Row-level policies integration suite (issue #7 / Phase 17 / roadmap F12).
 *
 * Boots the real server via `createServer()` against a throwaway scratch
 * database and exercises owner-scoped access end-to-end over real SQL. The
 * three acceptance policies come verbatim from the Gravity Well game
 * (issue #7):
 *
 *   (a) `players` — a signed-in (or anonymous-plugin guest) user may
 *       read/update **their own** row only (`rowPolicy: 'own'`);
 *   (b) `player_stats` — world-readable via the public role, writable by
 *       **no user role** — only the admin-bound `game-server` service key;
 *   (c) `matches` — readable by participants via the documented field-match
 *       workaround (`{ field: 'participant_ids', contains: 'actor.id' }`
 *       on a json column of user ids), insertable only by the service key.
 *
 * Plus the leak checks (list/get/aggregate/search exclusion, expand and
 * GraphQL relation traversal, bulk delete, upsert conflict hijack), the
 * admin/service bypass, and the policy-less-object compat guarantee.
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
let baseUrl = '';

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Shared state built up across the ordered tests. */
const state = {
  adminCookie: '',
  adminUserId: '',
  adminKey: '', // admin's own user-bound API key (test convenience)
  serviceKey: '', // the "game-server" key: role-bound to admin, no user
  serviceKeyId: '',
  bCookie: '',
  bUserId: '',
  cCookie: '',
  cUserId: '',
  guestCookie: '',
  guestUserId: '',
  playerRoleId: '',
  publicRoleId: '',
  anonymousRoleId: '',
  adminRoleId: '',
  ids: {} as Record<string, string>, // named record ids
};

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

/** Admin request (the bootstrap admin's user-bound API key). */
async function admin(method: Method, url: string, body?: unknown) {
  return request(method, url, { body, headers: { 'x-api-key': state.adminKey } });
}

/** The game-server service key (admin role binding, no user). */
async function service(method: Method, url: string, body?: unknown) {
  return request(method, url, { body, headers: { 'x-api-key': state.serviceKey } });
}

/** Session request as a given signed-in user. */
async function as(cookie: string, method: Method, url: string, body?: unknown) {
  return request(method, url, { body, headers: { cookie } });
}

/** Anonymous request — no credential of any kind. */
async function anon(method: Method, url: string, body?: unknown) {
  return request(method, url, { body });
}

/** GraphQL as a session user. */
async function gql(cookie: string, query: string) {
  return request('POST', '/api/v1/graphql', { body: { query }, headers: { cookie } });
}

/** Signs up an email user; returns { userId, cookie }. */
async function signup(email: string, name: string): Promise<{ userId: string; cookie: string }> {
  if (!app) throw new Error('Server not booted');
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: 'integration-Passw0rd', name }),
  });
  expect(res.statusCode).toBe(200);
  const user = (JSON.parse(res.body) as Json).user as Json;
  const cookie = res.cookies.find((c) => c.name.includes('session_token'));
  return { userId: user.id as string, cookie: `${cookie?.name}=${cookie?.value}` };
}

/**
 * One MCP JSON-RPC exchange over a real HTTP socket (see the explanation in
 * public-read.integration.test.ts — `.inject()` and the MCP transport's drain
 * timer do not mix).
 */
async function mcp(apiKey: string, payload: Json): Promise<{ status: number; body: Json }> {
  if (!baseUrl) throw new Error('Server not listening');
  const res = await fetch(`${baseUrl}/api/v1/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...payload }),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Json) : {};
  return { status: res.status, body };
}

/** Extracts the rows a `query_data` MCP tool call returned. */
function mcpRows(body: Json): Json[] {
  const content = ((body.result as Json)?.content as Json[])?.[0];
  const parsed = JSON.parse((content?.text as string) ?? '{}') as Json;
  return (parsed.data ?? []) as Json[];
}

const listData = (body: Json) => (body.data ?? []) as Json[];
const totalCount = (body: Json) => Number((body.pagination as Json)?.totalCount);

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
    anonymousAuth: true,
    publicUrl: 'http://rls.ion.test',
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    nodeEnv: 'test',
    logLevel: 'fatal',
  });
  // Real ephemeral listener for the MCP exchanges (see mcp()).
  await app.server.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.server.address();
  if (!address || typeof address === 'string') throw new Error('No listener address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  // Let any in-flight MCP drain timers (500ms, unref'd) fire while their
  // sockets still exist, so no timer callback outlives this file.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await app?.close();
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

describe('row-level policies (integration)', () => {
  it('bootstraps: admin, service key, game objects, and policy-carrying roles', async () => {
    // First signup becomes admin.
    const adminUser = await signup('rls-admin@ion.test', 'RLS Admin');
    state.adminUserId = adminUser.userId;
    state.adminCookie = adminUser.cookie;

    const adminKey = await request('POST', '/api/v1/api-keys', {
      body: { name: 'rls-admin', userId: state.adminUserId },
      headers: { cookie: state.adminCookie },
    });
    expect(adminKey.status).toBe(201);
    state.adminKey = (adminKey.body.data as Json).key as string;

    // Role ids.
    const roles = await admin('GET', '/api/v1/roles');
    const byName = new Map((roles.body.data as Json[]).map((r) => [r.name, r]));
    state.adminRoleId = (byName.get('admin') as Json).id as string;
    state.publicRoleId = (byName.get('public') as Json).id as string;
    state.anonymousRoleId = (byName.get('anonymous') as Json).id as string;

    // The game-server service key: bound to the admin role, no user — the
    // issue's workaround key must keep reading/writing everything (bypass).
    const svc = await admin('POST', '/api/v1/api-keys', {
      name: 'game-server',
      roleId: state.adminRoleId,
    });
    expect(svc.status).toBe(201);
    state.serviceKey = (svc.body.data as Json).key as string;
    state.serviceKeyId = (svc.body.data as Json).id as string;

    // Game objects.
    for (const [name, displayName, fields] of [
      [
        'rls_players',
        'RLS Players',
        [
          { name: 'handle', displayName: 'Handle', columnType: 'text', isUnique: true },
          { name: 'wins', displayName: 'Wins', columnType: 'integer' },
        ],
      ],
      [
        'rls_player_stats',
        'RLS Player Stats',
        [
          { name: 'player_handle', displayName: 'Player Handle', columnType: 'text' },
          { name: 'score', displayName: 'Score', columnType: 'integer' },
        ],
      ],
      [
        'rls_matches',
        'RLS Matches',
        [
          { name: 'title', displayName: 'Title', columnType: 'text' },
          { name: 'participant_ids', displayName: 'Participant Ids', columnType: 'json' },
        ],
      ],
      ['rls_lobbies', 'RLS Lobbies', [{ name: 'name', displayName: 'Name', columnType: 'text' }]],
    ] as const) {
      const created = await admin('POST', '/api/v1/schema/objects', {
        name,
        displayName,
        fields,
      });
      expect(created.status).toBe(201);
    }

    // Relationships for the traversal leak checks: stats → player, stats → lobby.
    for (const [name, target] of [
      ['player', 'rls_players'],
      ['lobby', 'rls_lobbies'],
    ] as const) {
      const rel = await admin('POST', '/api/v1/schema/relationships', {
        name,
        displayName: name,
        type: 'many_to_one',
        sourceObjectName: 'rls_player_stats',
        targetObjectName: target,
      });
      expect(rel.status).toBe(201);
    }

    // The `player` role — the three acceptance policies, verbatim:
    //   (a) players readable/updatable own-row-only,
    //   (b) player_stats: NO grant here (no user role can write it),
    //   (c) matches readable by participants (field-match on a json column
    //       of user ids — the documented relation workaround shape).
    const playerRole = await admin('POST', '/api/v1/roles', {
      name: 'player',
      description: 'Gravity Well players',
      permissions: [
        {
          resource: 'rls_players',
          actions: ['create', 'read', 'update', 'delete'],
          rowPolicy: 'own',
        },
        {
          resource: 'rls_matches',
          actions: ['read'],
          rowPolicy: { field: 'participant_ids', contains: 'actor.id' },
        },
      ],
    });
    expect(playerRole.status).toBe(201);
    state.playerRoleId = (playerRole.body.data as Json).id as string;

    // (b) world-readable player_stats via the public role; a public grant may
    // carry a rowPolicy too (lobbies: granted but zero rows — 'none').
    const pub = await admin('PATCH', `/api/v1/roles/${state.publicRoleId}`, {
      permissions: [
        { resource: 'rls_player_stats', actions: ['read'] },
        { resource: 'rls_lobbies', actions: ['read'], rowPolicy: 'none' },
      ],
    });
    expect(pub.status).toBe(200);

    // (a) includes anonymous-plugin guests: the built-in anonymous role gets
    // the same own-scoped players grant.
    const anonPatch = await admin('PATCH', `/api/v1/roles/${state.anonymousRoleId}`, {
      permissions: [
        { resource: 'rls_players', actions: ['create', 'read', 'update'], rowPolicy: 'own' },
      ],
    });
    expect(anonPatch.status).toBe(200);

    // Two real players + one guest.
    const b = await signup('rls-b@ion.test', 'Player B');
    state.bUserId = b.userId;
    state.bCookie = b.cookie;
    const c = await signup('rls-c@ion.test', 'Player C');
    state.cUserId = c.userId;
    state.cCookie = c.cookie;
    for (const userId of [state.bUserId, state.cUserId]) {
      const assigned = await admin('POST', `/api/v1/roles/${state.playerRoleId}/assignments`, {
        userId,
      });
      expect(assigned.status).toBe(201);
    }

    if (!app) throw new Error('Server not booted');
    const guest = await app.server.inject({ method: 'POST', url: '/api/auth/sign-in/anonymous' });
    expect(guest.statusCode).toBe(200);
    state.guestUserId = ((JSON.parse(guest.body) as Json).user as Json).id as string;
    const guestCookie = guest.cookies.find((cookie) => cookie.name.includes('session_token'));
    state.guestCookie = `${guestCookie?.name}=${guestCookie?.value}`;
  }, 60_000);

  it('rejects malformed row policies at the roles API (grant validation)', async () => {
    for (const rowPolicy of [
      'mine',
      { field: '' },
      { field: 'x' },
      { field: 'x', equals: 'actor.id', contains: 'actor.id' },
    ]) {
      const res = await admin('POST', '/api/v1/roles', {
        name: `bad_${Math.random().toString(36).slice(2, 8)}`,
        permissions: [{ resource: 'rls_players', actions: ['read'], rowPolicy }],
      });
      expect(res.status, JSON.stringify(rowPolicy)).toBe(400);
    }
  });

  // -------------------------------------------------------------------------
  // Policy (a): players — own-row-only for users and guests
  // -------------------------------------------------------------------------

  it('players: each principal creates a row it owns (server-stamped created_by)', async () => {
    const created: [string, () => Promise<{ status: number; body: Json }>, string][] = [
      [
        'ada',
        () => as(state.bCookie, 'POST', '/api/v1/data/rls_players', { handle: 'ada', wins: 5 }),
        state.bUserId,
      ],
      [
        'grace',
        () => as(state.cCookie, 'POST', '/api/v1/data/rls_players', { handle: 'grace', wins: 9 }),
        state.cUserId,
      ],
      [
        'gary',
        () =>
          as(state.guestCookie, 'POST', '/api/v1/data/rls_players', { handle: 'gary', wins: 1 }),
        state.guestUserId,
      ],
      [
        'npc',
        () => service('POST', '/api/v1/data/rls_players', { handle: 'npc', wins: 0 }),
        state.serviceKeyId,
      ],
    ];
    for (const [handle, make, owner] of created) {
      const res = await make();
      expect(res.status, handle).toBe(201);
      const row = res.body.data as Json;
      state.ids[handle] = row.id as string;
      expect(row.created_by, handle).toBe(owner);
    }
  });

  it('players: a user lists/aggregates only their own row (list, count, sum, search)', async () => {
    const list = await as(state.bCookie, 'GET', '/api/v1/data/rls_players');
    expect(list.status).toBe(200);
    expect(listData(list.body).map((r) => r.handle)).toEqual(['ada']);
    expect(totalCount(list.body)).toBe(1);

    // Aggregate respects the policy — a scoped count is not a data leak.
    const count = await as(state.bCookie, 'GET', '/api/v1/data/rls_players/aggregate?fn=count');
    expect((count.body.data as Json).value).toBe(1);
    const sum = await as(
      state.bCookie,
      'GET',
      '/api/v1/data/rls_players/aggregate?fn=sum&field=wins',
    );
    expect((sum.body.data as Json).value).toBe(5);

    // Free-text search cannot surface foreign rows.
    const search = await as(state.bCookie, 'GET', '/api/v1/data/rls_players?q=grace');
    expect(totalCount(search.body)).toBe(0);
  });

  it('players: get/update/delete on a foreign row 404s; own row works', async () => {
    const foreignGet = await as(
      state.bCookie,
      'GET',
      `/api/v1/data/rls_players/${state.ids.grace}`,
    );
    expect(foreignGet.status).toBe(404);

    const foreignPatch = await as(
      state.bCookie,
      'PATCH',
      `/api/v1/data/rls_players/${state.ids.grace}`,
      { wins: 999 },
    );
    expect(foreignPatch.status).toBe(404);

    const foreignDelete = await as(
      state.bCookie,
      'DELETE',
      `/api/v1/data/rls_players/${state.ids.grace}`,
    );
    expect(foreignDelete.status).toBe(404);

    const ownPatch = await as(state.bCookie, 'PATCH', `/api/v1/data/rls_players/${state.ids.ada}`, {
      wins: 6,
    });
    expect(ownPatch.status).toBe(200);
    expect((ownPatch.body.data as Json).wins).toBe(6);

    // Grace's row is untouched.
    const graceRow = await admin('GET', `/api/v1/data/rls_players/${state.ids.grace}`);
    expect((graceRow.body.data as Json).wins).toBe(9);
  });

  it('players: anonymous-plugin guests get the same own-row scope', async () => {
    const list = await as(state.guestCookie, 'GET', '/api/v1/data/rls_players');
    expect(listData(list.body).map((r) => r.handle)).toEqual(['gary']);

    const foreign = await as(state.guestCookie, 'GET', `/api/v1/data/rls_players/${state.ids.ada}`);
    expect(foreign.status).toBe(404);

    const own = await as(state.guestCookie, 'PATCH', `/api/v1/data/rls_players/${state.ids.gary}`, {
      wins: 2,
    });
    expect(own.status).toBe(200);
  });

  it('players: admin and the service key bypass row policies (all four rows)', async () => {
    for (const call of [
      () => admin('GET', '/api/v1/data/rls_players'),
      () => service('GET', '/api/v1/data/rls_players'),
    ]) {
      const res = await call();
      expect(totalCount(res.body)).toBe(4);
    }
    // The service key updates a user-owned row freely.
    const patched = await service('PATCH', `/api/v1/data/rls_players/${state.ids.ada}`, {
      wins: 7,
    });
    expect(patched.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Policy (b): player_stats — world-readable, service-key-writable only
  // -------------------------------------------------------------------------

  it('player_stats: the service key writes; rows land world-visible', async () => {
    const lobby = await service('POST', '/api/v1/data/rls_lobbies', { name: 'main' });
    expect(lobby.status).toBe(201);
    state.ids.lobby = (lobby.body.data as Json).id as string;

    const rows: [string, Json][] = [
      [
        's_ada',
        { player_handle: 'ada', score: 100, player_id: state.ids.ada, lobby_id: state.ids.lobby },
      ],
      ['s_grace', { player_handle: 'grace', score: 90, player_id: state.ids.grace }],
    ];
    for (const [key, body] of rows) {
      const res = await service('POST', '/api/v1/data/rls_player_stats', body);
      expect(res.status, key).toBe(201);
      state.ids[key] = (res.body.data as Json).id as string;
    }
  });

  it('player_stats: world-readable — anonymous and players read every row', async () => {
    const anonymous = await anon('GET', '/api/v1/data/rls_player_stats');
    expect(anonymous.status).toBe(200);
    expect(totalCount(anonymous.body)).toBe(2);

    // Authenticated players read via the public union (no grant of their own).
    const asPlayer = await as(state.bCookie, 'GET', '/api/v1/data/rls_player_stats');
    expect(totalCount(asPlayer.body)).toBe(2);
  });

  it('player_stats: no user role can write — only the service key (anti-cheat)', async () => {
    // Anonymous writes: 401 before any grant is consulted.
    expect((await anon('POST', '/api/v1/data/rls_player_stats', { score: 1 })).status).toBe(401);

    // Authenticated players and guests: 403 — no user role holds a write grant.
    for (const cookie of [state.bCookie, state.cCookie, state.guestCookie]) {
      expect((await as(cookie, 'POST', '/api/v1/data/rls_player_stats', { score: 1 })).status).toBe(
        403,
      );
      expect(
        (
          await as(cookie, 'PATCH', `/api/v1/data/rls_player_stats/${state.ids.s_ada}`, {
            score: 1,
          })
        ).status,
      ).toBe(403);
      expect(
        (await as(cookie, 'DELETE', `/api/v1/data/rls_player_stats/${state.ids.s_ada}`)).status,
      ).toBe(403);
    }

    // The service key updates server-computed stats freely.
    const svc = await service('PATCH', `/api/v1/data/rls_player_stats/${state.ids.s_ada}`, {
      score: 110,
    });
    expect(svc.status).toBe(200);
  });

  it('a public grant may carry a rowPolicy (granted lobbies, zero rows visible)', async () => {
    const res = await anon('GET', '/api/v1/data/rls_lobbies');
    expect(res.status).toBe(200); // object-level grant admits the request…
    expect(totalCount(res.body)).toBe(0); // …but the 'none' policy shows no rows
  });

  // -------------------------------------------------------------------------
  // Policy (c): matches — participant-scoped reads, service-key writes
  // -------------------------------------------------------------------------

  it('matches: the service key creates matches with participant user ids', async () => {
    const m1 = await service('POST', '/api/v1/data/rls_matches', {
      title: 'b-vs-c',
      participant_ids: [state.bUserId, state.cUserId],
    });
    expect(m1.status).toBe(201);
    state.ids.m1 = (m1.body.data as Json).id as string;

    const m2 = await service('POST', '/api/v1/data/rls_matches', {
      title: 'c-solo',
      participant_ids: [state.cUserId],
    });
    expect(m2.status).toBe(201);
    state.ids.m2 = (m2.body.data as Json).id as string;
  });

  it('matches: participants see exactly their matches; others 404', async () => {
    const forB = await as(state.bCookie, 'GET', '/api/v1/data/rls_matches');
    expect(listData(forB.body).map((r) => r.title)).toEqual(['b-vs-c']);
    expect(totalCount(forB.body)).toBe(1);

    const forC = await as(state.cCookie, 'GET', '/api/v1/data/rls_matches?sort=title');
    expect(listData(forC.body).map((r) => r.title)).toEqual(['b-vs-c', 'c-solo']);

    expect(
      (await as(state.bCookie, 'GET', `/api/v1/data/rls_matches/${state.ids.m2}`)).status,
    ).toBe(404);
    expect(
      (await as(state.bCookie, 'GET', `/api/v1/data/rls_matches/${state.ids.m1}`)).status,
    ).toBe(200);
  });

  it('matches: players cannot insert or update them (service key only)', async () => {
    const insert = await as(state.bCookie, 'POST', '/api/v1/data/rls_matches', {
      title: 'forged',
      participant_ids: [state.bUserId],
    });
    expect(insert.status).toBe(403);
    const patch = await as(state.bCookie, 'PATCH', `/api/v1/data/rls_matches/${state.ids.m1}`, {
      title: 'renamed',
    });
    expect(patch.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Leak checks
  // -------------------------------------------------------------------------

  it('upsert cannot hijack a foreign row through its conflict target', async () => {
    // C attacks B's unique handle: the conflict row is out of C's update
    // policy — 403, and B's row is untouched.
    const attack = await as(state.cCookie, 'POST', '/api/v1/data/rls_players?on_conflict=handle', {
      handle: 'ada',
      wins: 9999,
    });
    expect(attack.status).toBe(403);
    expect(attack.body.error).toBe('ROW_POLICY_DENIED');
    const ada = await admin('GET', `/api/v1/data/rls_players/${state.ids.ada}`);
    expect((ada.body.data as Json).wins).toBe(7);

    // Upserts within the policy still work: C's own conflict row updates…
    const own = await as(state.cCookie, 'POST', '/api/v1/data/rls_players?on_conflict=handle', {
      handle: 'grace',
      wins: 10,
    });
    expect(own.status).toBe(200);
    expect((own.body as Json).created).toBe(false);

    // …and a fresh handle inserts (create policy stamps ownership).
    const fresh = await as(state.cCookie, 'POST', '/api/v1/data/rls_players?on_conflict=handle', {
      handle: 'coco',
      wins: 0,
    });
    expect(fresh.status).toBe(201);
    state.ids.coco = (fresh.body.data as Json).id as string;
    expect((fresh.body.data as Json).created_by).toBe(state.cUserId);
  });

  it('bulk delete only touches own rows', async () => {
    const second = await as(state.bCookie, 'POST', '/api/v1/data/rls_players', {
      handle: 'ada2',
      wins: 0,
    });
    expect(second.status).toBe(201);
    const ada2Id = (second.body.data as Json).id as string;

    const bulk = await as(state.bCookie, 'DELETE', '/api/v1/data/rls_players/bulk', {
      ids: [ada2Id, state.ids.grace],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.count).toBe(1);
    expect(bulk.body.ids).toEqual([ada2Id]);
    expect((await admin('GET', `/api/v1/data/rls_players/${state.ids.grace}`)).status).toBe(200);
  });

  it('expand applies the target object policy (scoped) and fails closed without a grant', async () => {
    // B reads world-readable stats expanding into players: own player
    // hydrates, the foreign one is null — not leaked through the relation.
    const res = await as(
      state.bCookie,
      'GET',
      '/api/v1/data/rls_player_stats?expand=player,lobby&sort=player_handle',
    );
    expect(res.status).toBe(200);
    const rows = listData(res.body);
    expect(rows).toHaveLength(2);
    const adaStats = rows.find((r) => r.player_handle === 'ada') as Json;
    const graceStats = rows.find((r) => r.player_handle === 'grace') as Json;
    expect((adaStats.player as Json).handle).toBe('ada');
    expect(graceStats.player).toBeNull();

    // B has no grant at all on lobbies (and no platform-data grant): the
    // expansion fails closed even though the FK is set.
    expect(adaStats.lobby_id).toBe(state.ids.lobby);
    expect(adaStats.lobby).toBeNull();

    // The service key expands everything.
    const svc = await service('GET', '/api/v1/data/rls_player_stats?expand=player,lobby');
    const svcAda = listData(svc.body).find((r) => r.player_handle === 'ada') as Json;
    expect((svcAda.player as Json).handle).toBe('ada');
    expect((svcAda.lobby as Json).name).toBe('main');
  });

  it('a policy-less object behaves exactly as before (compat default)', async () => {
    // The editor role has no rowPolicy on its grants — full access unchanged.
    const roles = await admin('GET', '/api/v1/roles');
    const editor = (roles.body.data as Json[]).find((r) => r.name === 'editor') as Json;
    const d = await signup('rls-d@ion.test', 'Editor D');
    const assigned = await admin('POST', `/api/v1/roles/${editor.id as string}/assignments`, {
      userId: d.userId,
    });
    expect(assigned.status).toBe(201);

    const list = await as(d.cookie, 'GET', '/api/v1/data/rls_players');
    expect(totalCount(list.body)).toBe(5); // ada, coco, gary, grace, npc (ada2 was bulk-deleted)
    const all = listData(list.body)
      .map((r) => r.handle)
      .sort();
    expect(all).toEqual(['ada', 'coco', 'gary', 'grace', 'npc']);
  });

  // -------------------------------------------------------------------------
  // Surface parity: GraphQL + MCP
  // -------------------------------------------------------------------------

  it('GraphQL inherits the same scoping (list, get, aggregate, relation traversal)', async () => {
    // Open the GraphQL transport for players (platform `data` read); their
    // per-object policies keep applying because object grants exist.
    const patched = await admin('PATCH', `/api/v1/roles/${state.playerRoleId}`, {
      permissions: [
        {
          resource: 'rls_players',
          actions: ['create', 'read', 'update', 'delete'],
          rowPolicy: 'own',
        },
        {
          resource: 'rls_matches',
          actions: ['read'],
          rowPolicy: { field: 'participant_ids', contains: 'actor.id' },
        },
        { resource: 'data', actions: ['read'] },
      ],
    });
    expect(patched.status).toBe(200);

    const list = await gql(
      state.bCookie,
      '{ rls_players { data { handle } pagination { totalCount } } }',
    );
    expect(list.status).toBe(200);
    const players = (list.body.data as Json).rls_players as Json;
    expect((players.data as Json[]).map((r) => r.handle)).toEqual(['ada']);
    expect((players.pagination as Json).totalCount).toBe(1);

    const foreign = await gql(
      state.bCookie,
      `{ rls_players_by_id(id: "${state.ids.grace}") { handle } }`,
    );
    expect((foreign.body.data as Json).rls_players_by_id).toBeNull();

    const agg = await gql(state.bCookie, '{ rls_players_aggregate(fn: count) { filteredCount } }');
    expect(((agg.body.data as Json).rls_players_aggregate as Json).filteredCount).toBe(1);

    // Relation traversal: stats → player hydrates own, nulls foreign.
    const traversal = await gql(
      state.bCookie,
      '{ rls_player_stats { data { player_handle player { handle } } } }',
    );
    const rows = ((traversal.body.data as Json).rls_player_stats as Json).data as Json[];
    const ada = rows.find((r) => r.player_handle === 'ada') as Json;
    const grace = rows.find((r) => r.player_handle === 'grace') as Json;
    expect((ada.player as Json).handle).toBe('ada');
    expect(grace.player).toBeNull();

    // Matches stay participant-scoped on GraphQL too.
    const matches = await gql(state.bCookie, '{ rls_matches { data { title } } }');
    expect(
      (((matches.body.data as Json).rls_matches as Json).data as Json[]).map((r) => r.title),
    ).toEqual(['b-vs-c']);
  });

  it('MCP inherits the same scoping (query_data own rows; service key sees all)', async () => {
    // Give C's role MCP transport access via a second role (manage on the
    // `data` platform resource); the players object grant still scopes rows.
    const mcpRole = await admin('POST', '/api/v1/roles', {
      name: 'mcp_access',
      permissions: [{ resource: 'data', actions: ['manage'] }],
    });
    expect(mcpRole.status).toBe(201);
    const cKey = await admin('POST', '/api/v1/api-keys', {
      name: 'c-mcp',
      userId: state.cUserId,
    });
    expect(cKey.status).toBe(201);
    const assigned = await admin(
      'POST',
      `/api/v1/roles/${(mcpRole.body.data as Json).id as string}/assignments`,
      { userId: state.cUserId },
    );
    expect(assigned.status).toBe(201);

    const scoped = await mcp((cKey.body.data as Json).key as string, {
      method: 'tools/call',
      params: { name: 'query_data', arguments: { object_name: 'rls_players' } },
    });
    expect(scoped.status).toBe(200);
    expect(
      mcpRows(scoped.body)
        .map((r) => r.handle)
        .sort(),
    ).toEqual(['coco', 'grace']);

    const all = await mcp(state.serviceKey, {
      method: 'tools/call',
      params: { name: 'query_data', arguments: { object_name: 'rls_players' } },
    });
    expect(mcpRows(all.body)).toHaveLength(5);
  });
});
