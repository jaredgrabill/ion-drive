/**
 * Aggregate endpoint integration suite (issue #13 — leaderboard-shaped reads).
 *
 * Boots the real server via `createServer()` against a throwaway scratch
 * database (like `platform.integration.test.ts`) and exercises
 * `GET /api/v1/data/:object/aggregate` end-to-end over real SQL:
 *
 *   1. bootstrap (first signup → admin → API key) + a seeded `agg_players`
 *      object
 *   2. count/sum/avg/min/max, bare and with filters + free-text search
 *   3. count-with-field (non-null count) and the empty-set null semantics
 *   4. the documented RANK pattern: filtered `pagination.totalCount + 1`
 *      agreeing with the aggregate's `filteredCount + 1`
 *   5. validation 400s (missing/unknown fn, missing field, non-numeric field)
 *   6. GraphQL parity via `<object>_aggregate`
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

async function api(method: Method, url: string, body?: unknown) {
  return request(method, url, { body, headers: { 'x-api-key': auth.apiKey } });
}

/** Runs one aggregate query and returns the `{ fn, field, value, filteredCount }` payload. */
async function aggregate(qs: string): Promise<{ status: number; data: Json }> {
  const res = await api('GET', `/api/v1/data/agg_players/aggregate?${qs}`);
  return { status: res.status, data: (res.body.data ?? res.body) as Json };
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

describe('aggregate endpoint (integration)', () => {
  it('bootstraps auth and seeds a players object', async () => {
    if (!app) throw new Error('Server not booted');
    const signup = await app.server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'agg@ion.test',
        password: 'integration-Passw0rd',
        name: 'Agg Admin',
      }),
    });
    expect(signup.statusCode).toBe(200);
    const user = (JSON.parse(signup.body) as Json).user as Json;
    auth.userId = user.id as string;
    const sessionCookie = signup.cookies.find((c) => c.name.includes('session_token'));
    auth.cookie = `${sessionCookie?.name}=${sessionCookie?.value}`;

    const keyRes = await request('POST', '/api/v1/api-keys', {
      body: { name: 'agg-suite', userId: auth.userId },
      headers: { cookie: auth.cookie },
    });
    expect(keyRes.status).toBe(201);
    auth.apiKey = (keyRes.body.data as Json).key as string;

    const created = await api('POST', '/api/v1/schema/objects', {
      name: 'agg_players',
      displayName: 'Agg Players',
      fields: [
        { name: 'name', displayName: 'Name', columnType: 'text', isRequired: true },
        { name: 'region', displayName: 'Region', columnType: 'text' },
        { name: 'wins', displayName: 'Wins', columnType: 'integer' },
        { name: 'damage_dealt', displayName: 'Damage Dealt', columnType: 'float' },
      ],
    });
    expect(created.status).toBe(201);

    const seeded = await api('POST', '/api/v1/data/agg_players/bulk', {
      data: [
        { name: 'Ada', region: 'alpha', wins: 50, damage_dealt: 100.5 },
        { name: 'Grace', region: 'alpha', wins: 42, damage_dealt: 200.25 },
        { name: 'Alan', region: 'beta', wins: 42, damage_dealt: 50 },
        { name: 'Kat', region: 'beta', wins: 10, damage_dealt: null },
        { name: 'Mary', region: 'gamma', wins: 7, damage_dealt: 30 },
      ],
    });
    expect(seeded.status).toBe(201);
    expect(seeded.body.count).toBe(5);
  });

  it('requires the same read permission as listing (401 unauthenticated)', async () => {
    const res = await request('GET', '/api/v1/data/agg_players/aggregate?fn=count');
    expect(res.status).toBe(401);
  });

  it('computes a bare count matching the list totalCount', async () => {
    const { status, data } = await aggregate('fn=count');
    expect(status).toBe(200);
    expect(data).toEqual({ fn: 'count', field: null, value: 5, filteredCount: 5 });

    const list = await api('GET', '/api/v1/data/agg_players?pageSize=1');
    expect((list.body.pagination as Json).totalCount).toBe(5);
  });

  it('computes sum/avg/min/max over a numeric field', async () => {
    expect((await aggregate('fn=sum&field=wins')).data).toMatchObject({
      value: 151,
      filteredCount: 5,
    });
    expect((await aggregate('fn=avg&field=wins')).data).toMatchObject({ value: 30.2 });
    expect((await aggregate('fn=min&field=wins')).data).toMatchObject({ value: 7 });
    expect((await aggregate('fn=max&field=wins')).data).toMatchObject({ value: 50 });
  });

  it('applies the same filters as the list endpoint', async () => {
    // avg damage across the alpha region (Ada 100.5, Grace 200.25).
    const { data } = await aggregate('fn=avg&field=damage_dealt&region=alpha');
    expect(data).toMatchObject({ fn: 'avg', field: 'damage_dealt', filteredCount: 2 });
    expect(data.value).toBeCloseTo(150.375, 6);

    // Range filters compose (wins in [10, 42] → Grace, Alan, Kat).
    const range = await aggregate('fn=count&wins[gte]=10&wins[lte]=42');
    expect(range.data.filteredCount).toBe(3);
  });

  it('ANDs free-text search into the aggregate conditions', async () => {
    // q=ada matches only the name "Ada" among the text columns.
    expect((await aggregate('fn=count&q=ada')).data.filteredCount).toBe(1);
    // search + filter combine: alpha-region players with >= 45 wins → Ada only.
    const combined = await aggregate('fn=max&field=wins&search=alpha&wins[gte]=45');
    expect(combined.data).toMatchObject({ value: 50, filteredCount: 1 });
  });

  it('count with a field counts non-null values', async () => {
    const { data } = await aggregate('fn=count&field=damage_dealt');
    expect(data).toEqual({ fn: 'count', field: 'damage_dealt', value: 4, filteredCount: 5 });
  });

  it('returns value null (not 0) for an empty set', async () => {
    const { data } = await aggregate('fn=sum&field=wins&wins[gt]=1000');
    expect(data).toEqual({ fn: 'sum', field: 'wins', value: null, filteredCount: 0 });
  });

  it('supports the documented RANK pattern (filtered totalCount + 1)', async () => {
    // Grace has 42 wins. Players strictly ahead: Ada (50) → rank 2.
    const viaList = await api('GET', '/api/v1/data/agg_players?wins[gt]=42&pageSize=1');
    const rankFromList = Number((viaList.body.pagination as Json).totalCount) + 1;
    expect(rankFromList).toBe(2);

    // Same number through the aggregate endpoint, without fetching rows.
    const viaAggregate = await aggregate('fn=count&wins[gt]=42');
    expect(Number(viaAggregate.data.filteredCount) + 1).toBe(rankFromList);

    // Percentile from two counts: 100 * (1 - above/total) = 80 for Grace.
    const total = (await aggregate('fn=count')).data.filteredCount as number;
    const above = viaAggregate.data.filteredCount as number;
    expect(100 * (1 - above / total)).toBe(80);
  });

  it('rejects invalid aggregate requests with typed 400s', async () => {
    const missingFn = await api('GET', '/api/v1/data/agg_players/aggregate');
    expect(missingFn.status).toBe(400);

    const badFn = await aggregate('fn=median&field=wins');
    expect(badFn.status).toBe(400);
    // Multi-fn batching is deliberately unsupported (single fn per call).
    expect((await aggregate('fn=count,max&field=wins')).status).toBe(400);

    const noField = await api('GET', '/api/v1/data/agg_players/aggregate?fn=sum');
    expect(noField.status).toBe(400);
    expect(noField.body.error).toBe('AGGREGATE_FIELD_REQUIRED');

    const textField = await aggregate('fn=avg&field=name');
    expect(textField.status).toBe(400);

    const unknownField = await aggregate('fn=sum&field=nope');
    expect(unknownField.status).toBe(400);

    const unknownObject = await api('GET', '/api/v1/data/nope/aggregate?fn=count');
    expect(unknownObject.status).toBe(404);
  });

  it('exposes the same aggregate on GraphQL (surface parity)', async () => {
    const res = await api('POST', '/api/v1/graphql', {
      query: `{
        agg_players_aggregate(fn: avg, field: "wins",
          filter: [{ field: "region", operator: eq, value: "alpha" }]) {
          fn field value filteredCount
        }
      }`,
    });
    expect(res.status).toBe(200);
    const payload = (res.body.data as Json)?.agg_players_aggregate as Json;
    expect(payload).toMatchObject({ fn: 'avg', field: 'wins', filteredCount: 2 });
    expect(payload.value).toBeCloseTo(46, 6); // (50 + 42) / 2
  });
});
