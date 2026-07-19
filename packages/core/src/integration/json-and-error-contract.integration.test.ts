/**
 * JSON-column writes + Postgres error-contract integration suite
 * (issues #10 and #11).
 *
 * Boots the real server via `createServer()` against a throwaway scratch
 * database and asserts, over Fastify `.inject()`:
 *
 *   #10 — a `json` field accepts an actual JSON object/array on POST/PATCH
 *         (and a pre-encoded string for back-compat), and GET returns the
 *         same parsed value — the surface is symmetric.
 *   #11 — constraint violations surface as the documented contract instead
 *         of raw 500s: 23505 → 409 `unique_violation` (+ `field`), 23502 →
 *         400 `not_null_violation`, 22P02 → 400 `invalid_value`; internal
 *         constraint names never appear in responses.
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
const SCRATCH_DB = `ion_jec_${randomBytes(6).toString('hex')}`;

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
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  if (!app) throw new Error('Server not booted');
  const res = await app.server.inject({
    method,
    url,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  const parsed = res.body ? (JSON.parse(res.body) as Json) : {};
  return { status: res.statusCode, body: parsed };
}

/** Unwraps the `{ data: … }` envelope of a single-record response. */
function record(res: { body: Json }): Json {
  return res.body.data as Json;
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

  // Open mode: these suites exercise the data surface, not auth.
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

  // The dogfood shape from issue #10: a json config plus a unique device id
  // (issue #11's duplicate case) and a required name (the not-null case).
  const created = await request('POST', '/api/v1/schema/objects', {
    name: 'jec_matches',
    displayName: 'JEC Matches',
    fields: [
      { name: 'device_id', displayName: 'Device ID', columnType: 'text', isUnique: true },
      { name: 'full_name', displayName: 'Full Name', columnType: 'text', isRequired: true },
      { name: 'score', displayName: 'Score', columnType: 'integer' },
      { name: 'config_json', displayName: 'Config', columnType: 'json' },
    ],
  });
  if (created.status !== 201) {
    throw new Error(`Object creation failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (adminClient) {
    await adminClient.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await adminClient.end();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// #10 — json columns accept objects/arrays natively, symmetrically
// ---------------------------------------------------------------------------

describe('json column writes (issue #10)', () => {
  it('POST with a real JSON object → 201, and GET returns the same object', async () => {
    const config = { a: 1, nested: { flags: [true, 'x'], depth: 2 } };
    const posted = await request('POST', '/api/v1/data/jec_matches', {
      full_name: 'Object Round',
      config_json: config,
    });
    expect(posted.status).toBe(201);
    expect(record(posted).config_json).toEqual(config);

    const got = await request('GET', `/api/v1/data/jec_matches/${record(posted).id}`);
    expect(got.status).toBe(200);
    expect(record(got).config_json).toEqual(config);
  });

  it('POST with a JSON array → 201 and reads back as the same array', async () => {
    const rounds = [1, 2, { bonus: true }];
    const posted = await request('POST', '/api/v1/data/jec_matches', {
      full_name: 'Array Round',
      config_json: rounds,
    });
    expect(posted.status).toBe(201);

    const got = await request('GET', `/api/v1/data/jec_matches/${record(posted).id}`);
    expect(record(got).config_json).toEqual(rounds);
  });

  it('still accepts a pre-encoded JSON string (back-compat) and returns it parsed', async () => {
    const posted = await request('POST', '/api/v1/data/jec_matches', {
      full_name: 'String Round',
      config_json: '{"a":1}',
    });
    expect(posted.status).toBe(201);

    const got = await request('GET', `/api/v1/data/jec_matches/${record(posted).id}`);
    expect(record(got).config_json).toEqual({ a: 1 });
  });

  it('PATCH with a JSON object updates the column', async () => {
    const posted = await request('POST', '/api/v1/data/jec_matches', {
      full_name: 'Patch Round',
      config_json: { v: 1 },
    });
    expect(posted.status).toBe(201);

    const patched = await request('PATCH', `/api/v1/data/jec_matches/${record(posted).id}`, {
      config_json: { v: 2, extras: [1, 2] },
    });
    expect(patched.status).toBe(200);
    expect(record(patched).config_json).toEqual({ v: 2, extras: [1, 2] });
  });

  it('bulk create accepts JSON objects per record', async () => {
    const posted = await request('POST', '/api/v1/data/jec_matches/bulk', {
      data: [
        { full_name: 'Bulk A', config_json: { i: 1 } },
        { full_name: 'Bulk B', config_json: [{ i: 2 }] },
      ],
    });
    expect(posted.status).toBe(201);
    expect(posted.body.count).toBe(2);
  });

  it('GraphQL mutation accepts a JSON object for a json field (surface parity)', async () => {
    const res = await request('POST', '/api/v1/graphql', {
      query: `mutation Create($input: JecMatchesCreateInput!) {
        create_jec_matches(input: $input) { id config_json }
      }`,
      variables: {
        input: { full_name: 'GraphQL Round', config_json: { via: 'graphql', n: [1] } },
      },
    });
    expect(res.status).toBe(200);
    const payload = res.body.data as Json | null;
    expect(res.body.errors).toBeUndefined();
    expect((payload?.create_jec_matches as Json).config_json).toEqual({ via: 'graphql', n: [1] });
  });
});

// ---------------------------------------------------------------------------
// #11 — constraint violations follow the documented error contract
// ---------------------------------------------------------------------------

describe('constraint error contract (issue #11)', () => {
  it('duplicate unique value → 409 unique_violation naming the field, no constraint leak', async () => {
    const first = await request('POST', '/api/v1/data/jec_matches', {
      full_name: 'Dup One',
      device_id: 'device-dup-1',
    });
    expect(first.status).toBe(201);

    const second = await request('POST', '/api/v1/data/jec_matches', {
      full_name: 'Dup Two',
      device_id: 'device-dup-1',
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('unique_violation');
    expect(second.body.field).toBe('device_id');
    // The raw Postgres constraint name must not leak anywhere in the response.
    expect(JSON.stringify(second.body)).not.toContain('_key');
    expect(second.body.statusCode).toBeUndefined(); // not the Fastify 500 shape
  });

  it('missing required field → 400 not_null_violation naming the field', async () => {
    const res = await request('POST', '/api/v1/data/jec_matches', {
      device_id: 'device-nn-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not_null_violation');
    expect(res.body.field).toBe('full_name');
  });

  it('unparseable value for the column type → 400 invalid_value', async () => {
    const res = await request('POST', '/api/v1/data/jec_matches', {
      full_name: 'Bad Score',
      score: 'not-a-number',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_value');
  });
});
