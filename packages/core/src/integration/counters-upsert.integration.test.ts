/**
 * Integration suite for issue #9 — atomic increments, upsert, and composite
 * unique constraints, exercised against a real PostgreSQL through the full
 * server stack (Fastify inject → routes → DataService → Kysely → PG):
 *
 *   1. `constraints.uniqueTogether` on create materialises as a real UNIQUE
 *      constraint the database itself enforces
 *   2. PATCH `{ "$inc": n }` is concurrency-safe — N parallel increments all
 *      land (the exact bug class the read-modify-write pattern loses to)
 *   3. `POST ?on_conflict=` upserts: insert-then-update round trip with the
 *      created indicator and 201/200 statuses, on both a single unique
 *      column and a uniqueTogether group
 *   4. conflict-target and operator validation surface as friendly 400s
 *   5. `PATCH /api/v1/schema/objects/:name` round-trips constraint changes
 *      (dry-run preview, duplicate-data refusal, snapshot export/diff)
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

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';
const SCRATCH_DB = `ion_upsert_${randomBytes(6).toString('hex')}`;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type IonApp = Awaited<ReturnType<typeof createServer>>;

let adminClient: pg.Client | undefined;
/** Connected to the scratch DB — catalog assertions must look where the tables live. */
let scratchClient: pg.Client | undefined;
let app: IonApp | undefined;

/** Names of the UNIQUE constraints currently on a table (scratch DB catalog). */
async function uniqueConstraintsOn(table: string): Promise<string[]> {
  const res = await scratchClient?.query(
    `SELECT con.conname FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = $1 AND con.contype = 'u'`,
    [table],
  );
  return (res?.rows ?? []).map((r: { conname: string }) => r.conname);
}

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
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {} };
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
  scratchClient = new pg.Client({ connectionString: scratchUrl(), connectionTimeoutMillis: 5000 });
  await scratchClient.connect();

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

  // The shared fixture: counter-style stats keyed by unique(room_code, seed),
  // plus a single-column unique device_id — the issue #9 shape.
  const created = await request('POST', '/api/v1/schema/objects', {
    name: 'player_stats',
    displayName: 'Player Stats',
    fields: [
      { name: 'device_id', displayName: 'Device', columnType: 'text', isUnique: true },
      { name: 'room_code', displayName: 'Room', columnType: 'text' },
      { name: 'seed', displayName: 'Seed', columnType: 'integer' },
      { name: 'wins', displayName: 'Wins', columnType: 'integer', defaultValue: '0' },
      { name: 'damage', displayName: 'Damage', columnType: 'float', defaultValue: '0' },
      { name: 'label', displayName: 'Label', columnType: 'text' },
    ],
    constraints: { uniqueTogether: [['room_code', 'seed']] },
  });
  expect(created.status).toBe(201);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await scratchClient?.end();
  // Wait for the scratch DB's sessions to drain before the FORCE drop
  // (mirrors platform.integration.test.ts).
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

describe('composite unique constraints (uniqueTogether)', () => {
  it('materialises as a real UNIQUE constraint in Postgres', async () => {
    expect(await uniqueConstraintsOn('player_stats')).toContain(
      'ion_uq_player_stats_room_code_seed',
    );
  });

  it('is enforced by the database itself on duplicate inserts', async () => {
    const first = await request('POST', '/api/v1/data/player_stats', {
      device_id: 'dup-a',
      room_code: 'DUP',
      seed: 1,
    });
    expect(first.status).toBe(201);

    // Same (room_code, seed) pair — Postgres rejects it and the error
    // translation layer (data/errors.ts) maps the 23505 onto the platform
    // contract: 409 unique_violation naming the composite key's columns.
    const dup = await request('POST', '/api/v1/data/player_stats', {
      device_id: 'dup-b',
      room_code: 'DUP',
      seed: 1,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('unique_violation');
    expect(String(dup.body.field)).toBe('room_code, seed');
  });

  it('round-trips through the schema snapshot', async () => {
    const snapshot = await request('GET', '/api/v1/schema/snapshot');
    const obj = (snapshot.body.data as { objects: Json[] }).objects.find(
      (o) => o.name === 'player_stats',
    );
    expect(obj?.constraints).toEqual({ uniqueTogether: [['room_code', 'seed']] });

    // Re-applying the exported snapshot is a no-op diff.
    const diff = await request(
      'POST',
      '/api/v1/schema/snapshot?dryRun=true',
      snapshot.body.data as Json,
    );
    expect((diff.body.data as { changeCount: number }).changeCount).toBe(0);
  });
});

describe('atomic increments ($inc / $dec)', () => {
  let id = '';

  beforeAll(async () => {
    const res = await request('POST', '/api/v1/data/player_stats', {
      device_id: 'inc-target',
      room_code: 'INC',
      seed: 1,
      wins: 10,
      damage: 1.5,
    });
    id = String((res.body.data as Json).id);
  });

  it('applies $inc/$dec alongside plain sets in one PATCH', async () => {
    const res = await request('PATCH', `/api/v1/data/player_stats/${id}`, {
      wins: { $inc: 2 },
      damage: { $dec: 0.5 },
      label: 'patched',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ wins: 12, damage: 1, label: 'patched' });
  });

  it('is concurrency-safe: N parallel increments all land', async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request('PATCH', `/api/v1/data/player_stats/${id}`, { wins: { $inc: 1 } }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);

    const after = await request('GET', `/api/v1/data/player_stats/${id}`);
    expect((after.body.data as Json).wins).toBe(12 + N);
  });

  it('rejects $inc on non-numeric columns with a 400', async () => {
    const res = await request('PATCH', `/api/v1/data/player_stats/${id}`, {
      label: { $inc: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_ATOMIC_OP');
  });

  it('rejects malformed operator objects with a 400', async () => {
    const res = await request('PATCH', `/api/v1/data/player_stats/${id}`, {
      wins: { $inc: 1, $dec: 2 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_ATOMIC_OP');
  });
});

describe('upsert (?on_conflict=)', () => {
  it('inserts then updates through the same POST, with the created indicator', async () => {
    const insert = await request('POST', '/api/v1/data/player_stats?on_conflict=device_id', {
      device_id: 'ups-1',
      room_code: 'UPS',
      seed: 100,
      wins: 1,
    });
    expect(insert.status).toBe(201);
    expect(insert.body.created).toBe(true);
    expect((insert.body.data as Json).wins).toBe(1);
    const id = String((insert.body.data as Json).id);

    const update = await request('POST', '/api/v1/data/player_stats?on_conflict=device_id', {
      device_id: 'ups-1',
      wins: 7,
      label: 'merged',
    });
    expect(update.status).toBe(200);
    expect(update.body.created).toBe(false);
    expect(update.body.data).toMatchObject({ id, wins: 7, label: 'merged' });
    // Columns absent from the second body keep their values.
    expect((update.body.data as Json).room_code).toBe('UPS');
  });

  it('accepts a uniqueTogether group as conflict target (any column order)', async () => {
    const insert = await request('POST', '/api/v1/data/player_stats?on_conflict=seed,room_code', {
      device_id: 'ups-2',
      room_code: 'UPS2',
      seed: 7,
      wins: 1,
    });
    expect(insert.status).toBe(201);
    expect(insert.body.created).toBe(true);

    const update = await request('POST', '/api/v1/data/player_stats?on_conflict=room_code,seed', {
      device_id: 'ups-2',
      room_code: 'UPS2',
      seed: 7,
      wins: 2,
    });
    expect(update.status).toBe(200);
    expect(update.body.created).toBe(false);
    expect((update.body.data as Json).wins).toBe(2);
  });

  it('is race-safe: concurrent first-time upserts never 500', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request('POST', '/api/v1/data/player_stats?on_conflict=device_id', {
          device_id: 'race-1',
          room_code: 'RACE',
          seed: Math.floor(Math.random() * 2 ** 30),
        }),
      ),
    );
    const created = results.filter((r) => r.status === 201 && r.body.created === true);
    const updated = results.filter((r) => r.status === 200 && r.body.created === false);
    expect(created).toHaveLength(1);
    expect(created.length + updated.length).toBe(results.length);
  });

  it('maps a NON-target constraint hit during upsert to the 409 contract', async () => {
    // Upsert on (room_code, seed) whose insert collides on device_id — a
    // constraint the statement does NOT target still fires; translated()
    // maps it onto the platform error contract instead of a raw 500.
    const res = await request('POST', '/api/v1/data/player_stats?on_conflict=room_code,seed', {
      device_id: 'ups-1',
      room_code: 'FRESH',
      seed: 999,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('unique_violation');
    expect(res.body.field).toBe('device_id');
  });

  it('rejects an undeclared conflict target with a 400 naming valid ones', async () => {
    const res = await request('POST', '/api/v1/data/player_stats?on_conflict=label', {
      label: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CONFLICT_TARGET');
    expect(String(res.body.message)).toContain('device_id');
    expect(String(res.body.message)).toContain('(room_code, seed)');
  });

  it('rejects a body missing the conflict column value', async () => {
    const res = await request('POST', '/api/v1/data/player_stats?on_conflict=device_id', {
      wins: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_CONFLICT_VALUE');
  });
});

describe('constraint management (PATCH /schema/objects/:name)', () => {
  it('previews with dryRun, refuses duplicate data, and applies clean changes', async () => {
    // A second uniqueTogether group over (room_code, label): duplicates exist?
    // No — labels vary. First preview it.
    const preview = await request('PATCH', '/api/v1/schema/objects/player_stats?dryRun=true', {
      constraints: {
        uniqueTogether: [
          ['room_code', 'seed'],
          ['device_id', 'label'],
        ],
      },
    });
    expect(preview.status).toBe(200);
    const previewData = preview.body.data as { sqlStatements: string[]; isValid: boolean };
    expect(previewData.isValid).toBe(true);
    expect(previewData.sqlStatements.join('\n')).toContain('ion_uq_player_stats_device_id_label');

    // Apply, verify in the catalog, then revert to the original single group.
    const apply = await request('PATCH', '/api/v1/schema/objects/player_stats', {
      constraints: {
        uniqueTogether: [
          ['room_code', 'seed'],
          ['device_id', 'label'],
        ],
      },
    });
    expect(apply.status).toBe(200);

    expect(await uniqueConstraintsOn('player_stats')).toContain(
      'ion_uq_player_stats_device_id_label',
    );

    const revert = await request('PATCH', '/api/v1/schema/objects/player_stats', {
      constraints: { uniqueTogether: [['room_code', 'seed']] },
    });
    expect(revert.status).toBe(200);
    expect(await uniqueConstraintsOn('player_stats')).not.toContain(
      'ion_uq_player_stats_device_id_label',
    );
  });

  it('refuses a group whose live data already has duplicates, naming samples', async () => {
    // Two rows share room_code 'UPS'? Create a guaranteed duplicate pair on
    // (room_code, wins): both race rows share room_code RACE and wins null —
    // NULLs are skipped, so build an explicit duplicate instead.
    await request('POST', '/api/v1/data/player_stats', {
      device_id: 'dupe-1',
      room_code: 'DD',
      seed: 41,
      wins: 5,
    });
    await request('POST', '/api/v1/data/player_stats', {
      device_id: 'dupe-2',
      room_code: 'DD',
      seed: 42,
      wins: 5,
    });

    const res = await request('PATCH', '/api/v1/schema/objects/player_stats', {
      constraints: {
        uniqueTogether: [
          ['room_code', 'seed'],
          ['room_code', 'wins'],
        ],
      },
    });
    expect(res.status).toBe(422);
    const preview = (res.body as { preview: { errors: { code: string; message: string }[] } })
      .preview;
    expect(preview.errors[0]?.code).toBe('DUPLICATE_VALUES');
    expect(preview.errors[0]?.message).toContain('DD');
  });
});

describe('GraphQL parity', () => {
  it('performs atomic increments via the increment argument', async () => {
    const created = await request('POST', '/api/v1/data/player_stats', {
      device_id: 'gql-1',
      room_code: 'GQL',
      seed: 1,
      wins: 3,
    });
    const id = String((created.body.data as Json).id);

    const res = await request('POST', '/api/v1/graphql', {
      query: `mutation { update_player_stats(id: "${id}", increment: { wins: 4 }) { wins } }`,
    });
    expect(res.status).toBe(200);
    expect((res.body.data as Json).update_player_stats).toEqual({ wins: 7 });
  });

  it('upserts through the upsert mutation with the created flag', async () => {
    const first = await request('POST', '/api/v1/graphql', {
      query: `mutation {
        upsert_player_stats(
          input: { device_id: "gql-2", room_code: "GQL2", seed: 9, wins: 1 }
          onConflict: ["device_id"]
        ) { created data { wins } }
      }`,
    });
    expect(first.status).toBe(200);
    expect((first.body.data as Json).upsert_player_stats).toEqual({
      created: true,
      data: { wins: 1 },
    });

    const second = await request('POST', '/api/v1/graphql', {
      query: `mutation {
        upsert_player_stats(
          input: { device_id: "gql-2", room_code: "GQL2", seed: 9, wins: 5 }
          onConflict: ["device_id"]
        ) { created data { wins } }
      }`,
    });
    expect((second.body.data as Json).upsert_player_stats).toEqual({
      created: false,
      data: { wins: 5 },
    });
  });
});
