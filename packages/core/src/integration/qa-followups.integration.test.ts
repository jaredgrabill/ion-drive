/**
 * QA follow-ups integration suite (issue #23) — the behavioral fixes from the
 * Gravity Well dogfood sprint's QA passes, each verified end-to-end against a
 * real Postgres:
 *
 *  1. GraphQL maps DataServiceError onto typed GraphQL errors: upsert's
 *     INVALID_CONFLICT_TARGET and a live 409 unique_violation both surface
 *     with `extensions.code` (parity with REST) instead of yoga's masked
 *     INTERNAL_SERVER_ERROR;
 *  2. re-applying a uniqueTogether group whose physical `ion_uq_*` constraint
 *     survived a metadata loss (drift, induced here with direct SQL) is a
 *     translated 409 `already_exists` naming the constraint — not a raw 42P07
 *     500;
 *  3. `$inc` aimed at system or unknown columns is a 400 INVALID_ATOMIC_OP
 *     (it used to be a silent 200 no-op);
 *  4. PATCH /api/v1/roles/:id with a permissions-only body keeps the role's
 *     description (partial-update semantics; explicit null still clears).
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';
const SCRATCH_DB = `ion_qa_${randomBytes(6).toString('hex')}`;

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

async function request(
  method: Method,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  if (!app) throw new Error('Server not booted');
  const res = await app.server.inject({
    method,
    url,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }
      : {}),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {} };
}

/** Executes a GraphQL operation and returns the HTTP + GraphQL response. */
async function gql(query: string): Promise<{ status: number; body: Json }> {
  return request('POST', '/api/v1/graphql', { query });
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

  app = await createServer({
    databaseUrl: scratchUrl(),
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    nodeEnv: 'test',
    logLevel: 'fatal',
  });

  scratchClient = new pg.Client({ connectionString: scratchUrl() });
  await scratchClient.connect();

  // One object serves the whole suite: a unique slug (for unique_violation),
  // a room_code+seed pair (for the uniqueTogether drift scenario), and a
  // numeric score (for $inc).
  const created = await request('POST', '/api/v1/schema/objects', {
    name: 'qa_matches',
    displayName: 'QA Matches',
    fields: [
      { name: 'slug', displayName: 'Slug', columnType: 'text', isUnique: true },
      { name: 'room_code', displayName: 'Room Code', columnType: 'text' },
      { name: 'seed', displayName: 'Seed', columnType: 'integer' },
      { name: 'score', displayName: 'Score', columnType: 'integer' },
    ],
  });
  if (created.status !== 201) {
    throw new Error(`Failed to create qa_matches: ${JSON.stringify(created.body)}`);
  }
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

describe('1. GraphQL surfaces DataServiceError as typed errors', () => {
  it('reports upsert INVALID_CONFLICT_TARGET via extensions.code, not INTERNAL_SERVER_ERROR', async () => {
    const res = await gql(
      'mutation { upsert_qa_matches(input: { slug: "s1", score: 1 }, onConflict: ["score"]) { created } }',
    );
    expect(res.status).toBe(200);
    const error = (res.body.errors as Json[])?.[0] as Json;
    expect(error).toBeDefined();
    expect((error.extensions as Json)?.code).toBe('INVALID_CONFLICT_TARGET');
    expect(error.message).not.toContain('Unexpected error');
    expect(error.message).toContain('score');
  });

  it('reports a live unique violation (409-class) with its code and field', async () => {
    const first = await gql(
      'mutation { create_qa_matches(input: { slug: "dupe", score: 1 }) { id } }',
    );
    expect(first.body.errors).toBeUndefined();

    const second = await gql(
      'mutation { create_qa_matches(input: { slug: "dupe", score: 2 }) { id } }',
    );
    expect(second.status).toBe(200);
    const error = (second.body.errors as Json[])?.[0] as Json;
    expect((error.extensions as Json)?.code).toBe('unique_violation');
    expect((error.extensions as Json)?.field).toBe('slug');
    expect(error.message).toContain('already exists');
    // REST parity: the same write through REST is the documented 409 envelope.
    const rest = await request('POST', '/api/v1/data/qa_matches', { slug: 'dupe', score: 3 });
    expect(rest.status).toBe(409);
    expect(rest.body.error).toBe('unique_violation');
  });
});

describe('2. uniqueTogether re-apply under metadata drift', () => {
  it('translates the physical-constraint collision to 409 already_exists naming it', async () => {
    // Induce the drift the QA pass described: the physical ion_uq_* constraint
    // exists (created here with direct SQL, exactly as if metadata had been
    // lost after a legitimate apply) while `_ion_objects` knows nothing of it.
    await scratchClient?.query(
      'ALTER TABLE "qa_matches" ADD CONSTRAINT "ion_uq_qa_matches_room_code_seed" UNIQUE ("room_code", "seed")',
    );

    const res = await request('PATCH', '/api/v1/schema/objects/qa_matches', {
      constraints: { uniqueTogether: [['room_code', 'seed']] },
    });

    // A clean contract error, not a raw Postgres 42P07 500.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_exists');
    expect(res.body.message).toContain('ion_uq_qa_matches_room_code_seed');

    // Recovery path kept intact: drop the orphaned constraint and re-apply.
    await scratchClient?.query(
      'ALTER TABLE "qa_matches" DROP CONSTRAINT "ion_uq_qa_matches_room_code_seed"',
    );
    const reapply = await request('PATCH', '/api/v1/schema/objects/qa_matches', {
      constraints: { uniqueTogether: [['room_code', 'seed']] },
    });
    expect(reapply.status).toBe(200);
    expect(reapply.body.success).toBe(true);
  });
});

describe('3. $inc on system/unknown columns is a 400', () => {
  let rowId = '';

  it('still applies $inc to writable numeric columns', async () => {
    const created = await request('POST', '/api/v1/data/qa_matches', {
      slug: 'inc-target',
      score: 10,
    });
    expect(created.status).toBe(201);
    rowId = (created.body.data as Json).id as string;

    const bumped = await request('PATCH', `/api/v1/data/qa_matches/${rowId}`, {
      score: { $inc: 5 },
    });
    expect(bumped.status).toBe(200);
    expect((bumped.body.data as Json).score).toBe(15);
  });

  it('rejects $inc on a system column instead of silently no-opping', async () => {
    const res = await request('PATCH', `/api/v1/data/qa_matches/${rowId}`, {
      created_at: { $inc: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_ATOMIC_OP');
    expect(res.body.message).toContain('system field "created_at"');
  });

  it('rejects $inc on an unknown column instead of silently no-opping', async () => {
    const res = await request('PATCH', `/api/v1/data/qa_matches/${rowId}`, {
      ghost_column: { $inc: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_ATOMIC_OP');
    expect(res.body.message).toContain('unknown field "ghost_column"');

    // The row is untouched — the 400 really did stop the write.
    const row = await request('GET', `/api/v1/data/qa_matches/${rowId}`);
    expect((row.body.data as Json).score).toBe(15);
  });
});

describe('4. PATCH /api/v1/roles/:id partial-update semantics', () => {
  it('keeps the description on a permissions-only body; explicit null clears it', async () => {
    const created = await request('POST', '/api/v1/roles', {
      name: 'qa-scorekeeper',
      description: 'May read and write scores.',
      permissions: [{ resource: 'qa_matches', actions: ['read'] }],
    });
    expect(created.status).toBe(201);
    const roleId = (created.body.data as Json).id as string;

    // The QA repro: updating only the permissions used to wipe description.
    const patched = await request('PATCH', `/api/v1/roles/${roleId}`, {
      permissions: [{ resource: 'qa_matches', actions: ['read', 'update'] }],
    });
    expect(patched.status).toBe(200);
    expect((patched.body.data as Json).description).toBe('May read and write scores.');
    expect(((patched.body.data as Json).permissions as Json[])[0]?.actions).toEqual([
      'read',
      'update',
    ]);

    // Explicit null is still the way to clear it.
    const cleared = await request('PATCH', `/api/v1/roles/${roleId}`, { description: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body.data as Json).description).toBeNull();
    // …and the permissions from the previous PATCH survived this one.
    expect(((cleared.body.data as Json).permissions as Json[])[0]?.actions).toEqual([
      'read',
      'update',
    ]);
  });
});
