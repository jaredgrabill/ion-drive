/**
 * Platform integration suite — the codified live smoke (see
 * `.claude/skills/live-smoke/SKILL.md` and docs/roadmap.md Phase 11 item 2).
 *
 * Boots the **real** server via `createServer()` against a throwaway scratch
 * database (created in beforeAll, dropped in afterAll — the database named in
 * `ION_DATABASE_URL` is only used as the connection point for CREATE/DROP
 * DATABASE) and exercises the core lifecycle over Fastify `.inject()`:
 *
 *   1. health check
 *   2. RBAC enforcement (401 without credentials)
 *   3. first signup → auto-admin → API key minting
 *   4. runtime object creation → immediate REST CRUD (filters, search,
 *      pagination, typed constraint violations)
 *   5. relationships + `expand=` hydration (list and getById)
 *   6. GraphQL list query with a filter
 *   7. transactional-outbox events in `_ion_events`
 *   8. block lifecycle (install → seed → guarded uninstall → dropData),
 *      including the spec-02 dependency-range + requires.core preflight
 *
 * Run with a reachable Postgres 17 (defaults match CI's service container):
 *
 *   ION_DATABASE_URL=postgresql://ion:ion@localhost:5432/ion_drive \
 *     pnpm --filter @ion-drive/core test:integration
 *
 * The suite fails fast with a clear message when Postgres is unreachable —
 * it never silently passes.
 */

import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

// ---------------------------------------------------------------------------
// Scratch database plumbing
// ---------------------------------------------------------------------------

/** Connection point; the CI job and repo compose both expose these creds. */
const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';

/** Unique per-run database so parallel/aborted runs never collide. */
const SCRATCH_DB = `ion_it_${randomBytes(6).toString('hex')}`;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

type IonApp = Awaited<ReturnType<typeof createServer>>;

let adminClient: pg.Client | undefined;
let scratchClient: pg.Client | undefined;
let app: IonApp | undefined;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Auth material captured during the bootstrap test and reused everywhere. */
const auth = { cookie: '', userId: '', apiKey: '' };

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

/** Same as {@link request} but authenticated with the minted API key. */
async function api(method: Method, url: string, body?: unknown) {
  return request(method, url, { body, headers: { 'x-api-key': auth.apiKey } });
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

  // Boot the real server against the scratch DB. Enforcement ON so RBAC is
  // actually exercised; rate limiting OFF so the request burst never 429s;
  // telemetry export off (its default). Tasks/blocks/events stay at defaults.
  app = await createServer({
    databaseUrl: scratchUrl(),
    requireAuth: true,
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    nodeEnv: 'test',
    logLevel: 'fatal',
  });

  // Direct connection to the scratch DB for outbox assertions.
  scratchClient = new pg.Client({ connectionString: scratchUrl() });
  await scratchClient.connect();
}, 120_000);

afterAll(async () => {
  await scratchClient?.end();
  await app?.close();
  // pg-pool's end() resolves without awaiting each client's socket close (the
  // Terminate packets are still in flight for a few ms), so wait until
  // Postgres sees no sessions on the scratch DB before dropping it — the
  // FORCE drop would otherwise terminate the stragglers and their 57P01
  // error events fail the run as unhandled. A true connection leak still
  // gets cleaned up by FORCE after the wait times out.
  await eventually(async () => {
    const res = await adminClient?.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [SCRATCH_DB],
    );
    return res?.rows[0].n === 0;
  }, 10_000).catch(() => undefined);
  await adminClient?.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await adminClient?.end();
}, 60_000);

// ---------------------------------------------------------------------------
// The suite (tests run in order and share state, mirroring the live smokes)
// ---------------------------------------------------------------------------

describe('platform lifecycle (integration)', () => {
  it('responds to the health check', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.schemaVersion).toBe('number');
  });

  it('rejects unauthenticated and badly-authenticated requests when enforcement is on', async () => {
    expect((await request('GET', '/api/v1/data')).status).toBe(401);
    expect((await request('GET', '/api/v1/schema/objects')).status).toBe(401);
    const bogus = await request('GET', '/api/v1/data', {
      headers: { 'x-api-key': 'iond_not_a_real_key' },
    });
    expect(bogus.status).toBe(401);
  });

  it('makes the first signup an admin and mints an API key', async () => {
    if (!app) throw new Error('Server not booted');
    // Raw inject so we can read the Set-Cookie of the auto-signed-in session.
    const signup = await app.server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'first@ion.test',
        password: 'integration-Passw0rd',
        name: 'First Admin',
      }),
    });
    expect(signup.statusCode).toBe(200);
    const user = (JSON.parse(signup.body) as Json).user as Json;
    expect(typeof user?.id).toBe('string');
    auth.userId = user.id as string;

    const sessionCookie = signup.cookies.find((c) => c.name.includes('session_token'));
    expect(sessionCookie).toBeDefined();
    auth.cookie = `${sessionCookie?.name}=${sessionCookie?.value}`;

    // Mint an API key bound to the admin user (RBAC flows through its roles).
    const keyRes = await request('POST', '/api/v1/api-keys', {
      body: { name: 'integration-suite', userId: auth.userId },
      headers: { cookie: auth.cookie },
    });
    expect(keyRes.status).toBe(201);
    const key = (keyRes.body.data as Json)?.key as string;
    expect(key).toMatch(/^iond_/);
    auth.apiKey = key;

    // The key resolves to the auto-granted admin role.
    const me = await api('GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.roles).toContain('admin');
  });

  it('creates a data object whose REST endpoints are live immediately', async () => {
    const created = await api('POST', '/api/v1/schema/objects', {
      name: 'it_contacts',
      displayName: 'IT Contacts',
      fields: [
        { name: 'full_name', displayName: 'Full Name', columnType: 'text', isRequired: true },
        {
          name: 'age',
          displayName: 'Age',
          columnType: 'integer',
          constraints: { min: 0, max: 150 },
        },
        {
          name: 'stage',
          displayName: 'Stage',
          columnType: 'enum',
          defaultValue: 'lead',
          constraints: { enumValues: ['lead', 'qualified', 'customer'] },
        },
      ],
    });
    expect(created.status).toBe(201);

    // CRUD works with no restart / re-registration.
    const ada = await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Ada Lovelace',
      age: 36,
      stage: 'customer',
    });
    expect(ada.status).toBe(201);
    const adaRow = ada.body.data as Json;
    expect(typeof adaRow.id).toBe('string');
    // Enum default applied by Postgres:
    const grace = await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Grace Hopper',
      age: 28,
    });
    expect(grace.status).toBe(201);
    expect((grace.body.data as Json).stage).toBe('lead');
    const alan = await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Alan Turing',
      age: 41,
      stage: 'qualified',
    });
    expect(alan.status).toBe(201);

    // List + pagination envelope.
    const list = await api('GET', '/api/v1/data/it_contacts');
    expect(list.status).toBe(200);
    expect((list.body.data as Json[]).length).toBe(3);
    expect((list.body.pagination as Json).totalCount).toBe(3);

    // Operator filter and free-text search.
    const over30 = await api('GET', '/api/v1/data/it_contacts?age[gt]=30');
    expect((over30.body.data as Json[]).length).toBe(2);
    const search = await api('GET', '/api/v1/data/it_contacts?q=grace');
    expect((search.body.data as Json[]).length).toBe(1);
    expect(((search.body.data as Json[])[0] as Json).full_name).toBe('Grace Hopper');

    // PATCH round-trips.
    const patched = await api('PATCH', `/api/v1/data/it_contacts/${adaRow.id}`, { age: 37 });
    expect(patched.status).toBe(200);
    expect((patched.body.data as Json).age).toBe(37);
  });

  it('returns a typed 400 for constraint violations', async () => {
    const negativeAge = await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Bad Data',
      age: -5,
    });
    expect(negativeAge.status).toBe(400);
    expect(negativeAge.body.error).toBe('CONSTRAINT_VIOLATION');

    const badStage = await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Bad Stage',
      stage: 'bogus',
    });
    expect(badStage.status).toBe(400);
    expect(badStage.body.error).toBe('CONSTRAINT_VIOLATION');
  });

  it('deletes records (204, then 404)', async () => {
    const doomed = await api('POST', '/api/v1/data/it_contacts', { full_name: 'Deleted Dave' });
    const id = (doomed.body.data as Json).id as string;
    expect((await api('DELETE', `/api/v1/data/it_contacts/${id}`)).status).toBe(204);
    expect((await api('GET', `/api/v1/data/it_contacts/${id}`)).status).toBe(404);
  });

  it('hydrates many_to_one relationships via expand= on list and getById', async () => {
    const companies = await api('POST', '/api/v1/schema/objects', {
      name: 'it_companies',
      displayName: 'IT Companies',
      fields: [{ name: 'name', displayName: 'Name', columnType: 'text', isRequired: true }],
    });
    expect(companies.status).toBe(201);

    const rel = await api('POST', '/api/v1/schema/relationships', {
      name: 'company',
      displayName: 'Company',
      type: 'many_to_one',
      sourceObjectName: 'it_contacts',
      targetObjectName: 'it_companies',
    });
    expect(rel.status).toBe(201);

    const acme = await api('POST', '/api/v1/data/it_companies', { name: 'Acme Corp' });
    const acmeId = (acme.body.data as Json).id as string;
    const larry = await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Linked Larry',
      company_id: acmeId,
    });
    expect(larry.status).toBe(201);
    const larryId = (larry.body.data as Json).id as string;

    const list = await api('GET', '/api/v1/data/it_contacts?q=larry&expand=company');
    const row = (list.body.data as Json[])[0] as Json;
    expect((row.company as Json)?.name).toBe('Acme Corp');

    const single = await api('GET', `/api/v1/data/it_contacts/${larryId}?expand=company`);
    expect(((single.body.data as Json).company as Json)?.id).toBe(acmeId);
  });

  it('answers GraphQL list queries with filters', async () => {
    const res = await api('POST', '/api/v1/graphql', {
      query: `query Over30($filter: [FilterInput!]) {
        it_contacts(filter: $filter) {
          data { id full_name age }
          pagination { totalCount }
        }
      }`,
      variables: { filter: [{ field: 'age', operator: 'gt', value: 30 }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const result = (res.body.data as Json).it_contacts as Json;
    // Ada (37, patched) and Alan (41); Grace (28) and Larry (no age) excluded.
    expect((result.pagination as Json).totalCount).toBe(2);
    const names = (result.data as Json[]).map((r) => r.full_name);
    expect(names).toContain('Ada Lovelace');
    expect(names).toContain('Alan Turing');
  });

  it('records CRUD events in the transactional outbox', async () => {
    if (!scratchClient) throw new Error('Scratch client not connected');
    // Publishes are atomic with the write, so the rows are already committed —
    // no need to race the dispatcher.
    const created = await scratchClient.query(
      "SELECT payload FROM _ion_events WHERE topic = 'data.it_contacts.created'",
    );
    expect(created.rowCount).toBeGreaterThanOrEqual(4);
    const payload = created.rows[0].payload as Json;
    expect(payload.object).toBe('it_contacts');
    expect(payload.op).toBe('created');
    expect(payload.after).toBeTruthy();

    const updated = await scratchClient.query(
      "SELECT count(*)::int AS n FROM _ion_events WHERE topic = 'data.it_contacts.updated'",
    );
    expect(updated.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('installs, guards, and uninstalls a block', async () => {
    // Inline manifest — core must not depend on @ion-drive/blocks
    // (the package graph is deliberately acyclic; see ADR-013).
    const manifest = {
      name: 'it_kit',
      version: '0.0.1',
      title: 'Integration Kit',
      description: 'Tiny block used by the integration suite.',
      objects: [
        {
          name: 'it_projects',
          displayName: 'IT Projects',
          fields: [
            { name: 'title', displayName: 'Title', columnType: 'text', isRequired: true },
            {
              name: 'status',
              displayName: 'Status',
              columnType: 'enum',
              constraints: { enumValues: ['open', 'done'] },
            },
          ],
        },
        {
          name: 'it_notes',
          displayName: 'IT Notes',
          fields: [{ name: 'body', displayName: 'Body', columnType: 'text', isRequired: true }],
        },
      ],
      relationships: [
        {
          name: 'project',
          displayName: 'Project',
          type: 'many_to_one',
          sourceObjectName: 'it_notes',
          targetObjectName: 'it_projects',
        },
      ],
      seed: { it_projects: [{ title: 'Bootstrap', status: 'open' }] },
    };

    // Dependency guard: unmet block dependencies are rejected server-side.
    const dependent = await api('POST', '/api/v1/blocks/install', {
      manifest: { ...manifest, name: 'it_dependent', dependencies: { it_missing: '*' } },
    });
    expect(dependent.status).toBe(422);

    const install = await api('POST', '/api/v1/blocks/install', { manifest });
    expect(install.status).toBe(201);
    const report = install.body.data as Json;
    expect(report.objectsCreated).toEqual(expect.arrayContaining(['it_projects', 'it_notes']));
    expect((report.recordsSeeded as Json).it_projects).toBe(1);

    // The block's objects are live on the data surface, seed included.
    const projects = await api('GET', '/api/v1/data/it_projects');
    expect(projects.status).toBe(200);
    expect((projects.body.data as Json[]).length).toBe(1);
    expect(((projects.body.data as Json[])[0] as Json).title).toBe('Bootstrap');

    // Data-loss guard: uninstalling with rows present requires dropData.
    const guarded = await api('DELETE', '/api/v1/blocks/it_kit');
    expect(guarded.status).toBe(409);

    const uninstall = await api('DELETE', '/api/v1/blocks/it_kit?dropData=true');
    expect(uninstall.status).toBe(200);
    expect((await api('GET', '/api/v1/schema/objects/it_projects')).status).toBe(404);
    expect((await api('GET', '/api/v1/data/it_projects')).status).toBe(404);
  });

  it('enforces dependency ranges and requires.core (spec-02)', async () => {
    // Minimal schemaless blocks — this scenario is about the preflight guards.
    const depA = { name: 'it_dep_a', version: '0.1.0', title: 'IT Dep A' };
    const depB = {
      name: 'it_dep_b',
      version: '0.1.0',
      title: 'IT Dep B',
      dependencies: { it_dep_a: '^0.2.0' },
    };

    expect((await api('POST', '/api/v1/blocks/install', { manifest: depA })).status).toBe(201);

    // Installed-but-out-of-range dependency → 422 with the machine-readable code.
    const outOfRange = await api('POST', '/api/v1/blocks/install', { manifest: depB });
    expect(outOfRange.status).toBe(422);
    expect(outOfRange.body.code).toBe('DEPENDENCY_VERSION');
    expect(outOfRange.body.message).toContain('it_dep_a@^0.2.0');
    expect(outOfRange.body.message).toContain('it_dep_a@0.1.0');

    // force overrides the range with a warning in the report.
    const forced = await api('POST', '/api/v1/blocks/install?force=true', { manifest: depB });
    expect(forced.status).toBe(201);
    expect((forced.body.data as Json).warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('overridden by force')]),
    );

    // requires.core excluding the running version → 400 naming both…
    const impossible = {
      name: 'it_core_pin',
      version: '0.1.0',
      title: 'IT Core Pin',
      requires: { core: '<0.0.1' },
    };
    const rejected = await api('POST', '/api/v1/blocks/install', { manifest: impossible });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toContain('requires core <0.0.1');
    // …while a dry run reports the same fact as a warning without failing.
    const dryRun = await api('POST', '/api/v1/blocks/install?dryRun=true', {
      manifest: impossible,
    });
    expect(dryRun.status).toBe(200);
    expect((dryRun.body.data as Json).warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('requires core <0.0.1')]),
    );

    // Cleanup (dependents first — the uninstall guard is exercised elsewhere;
    // it_core_pin left a `failed` ledger row behind, removed the same way).
    expect((await api('DELETE', '/api/v1/blocks/it_dep_b')).status).toBe(200);
    expect((await api('DELETE', '/api/v1/blocks/it_dep_a')).status).toBe(200);
    expect((await api('DELETE', '/api/v1/blocks/it_core_pin')).status).toBe(200);
  });

  it('exposes block actions and hooks with requires validation (Phase 14)', async () => {
    if (!app) throw new Error('Server not booted');

    const manifest = {
      name: 'it_logic',
      version: '0.0.1',
      title: 'Integration Logic Block',
      objects: [
        {
          name: 'it_widgets',
          displayName: 'IT Widgets',
          fields: [{ name: 'label', displayName: 'Label', columnType: 'text', isRequired: true }],
        },
      ],
      actions: [{ name: 'stamp', description: 'Creates a widget with a stamped label.' }],
      hooks: [{ name: 'echo' }],
    };

    // Requires validation: install fails actionably while no handler is registered…
    const missing = await api('POST', '/api/v1/blocks/install', { manifest });
    expect(missing.status).toBe(500);
    expect(missing.body.message).toContain('did you vendor its code?');
    expect(missing.body.message).toContain('/blocks/it_logic');
    // …and preview reports the same facts as warnings instead of failing.
    const preview = await api('POST', '/api/v1/blocks/preview', { manifest });
    expect(preview.status).toBe(200);
    expect((preview.body.data as Json).warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('it_logic.stamp')]),
    );

    // Simulate the vendored plugin registering its handlers (in a scaffolded
    // project this happens in the block plugin's setup at boot).
    app.actionRegistry.registerAction({
      block: 'it_logic',
      name: 'stamp',
      handler: async (ctx) => {
        const created = await ctx.dataService.create('it_widgets', {
          label: `stamped:${String(ctx.input.label ?? 'default')}`,
        });
        return { id: created.data.id, label: created.data.label };
      },
    });
    app.actionRegistry.registerHook({
      block: 'it_logic',
      name: 'echo',
      handler: async (ctx) => ({
        status: 202,
        body: { bytes: ctx.rawBody.length, method: ctx.method },
      }),
    });

    const install = await api('POST', '/api/v1/blocks/install', { manifest });
    expect(install.status).toBe(201);
    expect((install.body.data as Json).actionsExposed).toEqual(['stamp']);

    // RBAC: unauthenticated invocation is rejected; the admin API key passes.
    const unauthed = await request('POST', '/api/v1/blocks/it_logic/actions/stamp', {
      body: { label: 'x' },
    });
    expect(unauthed.status).toBe(401);

    const invoked = await api('POST', '/api/v1/blocks/it_logic/actions/stamp', { label: 'x' });
    expect(invoked.status).toBe(200);
    expect((invoked.body.data as Json).label).toBe('stamped:x');

    // Undeclared action → 404 (declaration-gated surface).
    expect((await api('POST', '/api/v1/blocks/it_logic/actions/nope', {})).status).toBe(404);

    // Hooks are session-auth exempt and receive the raw body.
    const hook = await request('POST', '/api/v1/hooks/it_logic/echo', {
      body: { hello: true },
    });
    expect(hook.status).toBe(202);
    expect(hook.body).toEqual({ bytes: JSON.stringify({ hello: true }).length, method: 'POST' });

    // The action rides the docs surfaces: OpenAPI path + MCP-visible listing.
    const spec = await request('GET', '/api/v1/openapi.json');
    expect(Object.keys(spec.body.paths as Json)).toEqual(
      expect.arrayContaining([
        '/api/v1/blocks/it_logic/actions/stamp',
        '/api/v1/hooks/it_logic/echo',
      ]),
    );

    await api('DELETE', '/api/v1/blocks/it_logic?dropData=true');
  });
});

// ---------------------------------------------------------------------------
// Phase 12 — events to the edge (actor identity, webhooks, realtime, DLQ)
// ---------------------------------------------------------------------------

/** Polls `fn` until it returns truthy or the timeout elapses. */
async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('eventually(): timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('events to the edge (Phase 12)', () => {
  it('stamps created_by/updated_by from the authenticated actor and carries it on events', async () => {
    const created = await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Actor Test',
      age: 85,
    });
    expect(created.status).toBe(201);
    const row = created.body.data as Json;
    expect(row.created_by).toBe(auth.userId);
    expect(row.updated_by).toBe(auth.userId);

    // Client-supplied actor columns are ignored, not trusted.
    const forged = await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Mallory',
      created_by: 'forged',
    });
    expect((forged.body.data as Json).created_by).toBe(auth.userId);

    // The change event carries the structured actor.
    if (!scratchClient) throw new Error('Scratch client not connected');
    const event = await scratchClient.query(
      `SELECT payload FROM _ion_events
       WHERE topic = 'data.it_contacts.created' AND payload->>'id' = $1`,
      [row.id],
    );
    const actor = (event.rows[0].payload as Json).actor as Json;
    expect(actor.userId).toBe(auth.userId);

    // Schema migrations record their actor too (objects were created via API).
    const migrations = await scratchClient.query(
      'SELECT count(*)::int AS n FROM _ion_migrations WHERE applied_by = $1',
      [auth.userId],
    );
    expect(migrations.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('delivers signed webhooks end-to-end and logs them in the delivery ledger', async () => {
    // A local receiver capturing raw bodies + headers.
    const received: { body: string; headers: http.IncomingHttpHeaders }[] = [];
    const receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({ body, headers: req.headers });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const port = (receiver.address() as AddressInfo).port;

    try {
      const createHook = await api('POST', '/api/v1/webhooks', {
        name: 'it-receiver',
        url: `http://127.0.0.1:${port}/hook`,
        topics: ['data.it_contacts.created'],
      });
      expect(createHook.status).toBe(201);
      const hook = createHook.body.data as Json;
      const secret = hook.secret as string;
      expect(secret).toMatch(/^whsec_/);
      // The secret is never readable again.
      const fetched = await api('GET', `/api/v1/webhooks/${hook.id}`);
      expect(fetched.body.data).not.toHaveProperty('secret');

      await api('POST', '/api/v1/data/it_contacts', {
        full_name: 'Webhook Target',
        email: 'target@ion.test',
      });

      const delivery = await eventually(async () => received[0]);
      // Signature verifies over "<t>.<raw body>" with the once-shown secret.
      const signature = String(delivery.headers['x-ion-signature']);
      const t = /t=(\d+)/.exec(signature)?.[1];
      const expected = createHmac('sha256', secret).update(`${t}.${delivery.body}`).digest('hex');
      expect(signature).toContain(`v1=${expected}`);
      const envelope = JSON.parse(delivery.body) as Json;
      expect(envelope.topic).toBe('data.it_contacts.created');

      // The ledger recorded the delivery as done for this webhook's group.
      const ledger = await eventually(async () => {
        const res = await api(
          'GET',
          `/api/v1/events/deliveries?consumer=webhook:${hook.id}&status=done`,
        );
        return (res.body.data as Json[]).length > 0 ? res.body.data : undefined;
      });
      expect((ledger as Json[])[0]?.consumer).toBe(`webhook:${hook.id}`);
    } finally {
      receiver.close();
    }
  });

  it('failed deliveries appear in the DLQ view and the retry endpoint revives them', async () => {
    // A receiver that 500s until told otherwise — a deterministic, fast
    // delivery failure (a dead port can hang through SYN retries on some
    // platforms). Flipping `healthy` simulates the downstream recovering.
    let healthy = false;
    const failing = http.createServer((_req, res) =>
      healthy ? res.writeHead(200).end('ok') : res.writeHead(500).end('boom'),
    );
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const failPort = (failing.address() as AddressInfo).port;

    const deadEndHook = await api('POST', '/api/v1/webhooks', {
      name: 'it-dead-end',
      url: `http://127.0.0.1:${failPort}/void`,
      topics: ['data.it_contacts.updated'],
    });
    expect(deadEndHook.status).toBe(201);
    const hookId = (deadEndHook.body.data as Json).id as string;
    const consumer = `webhook:${hookId}`;

    // Trigger a matching event (update an existing contact).
    const contacts = await api('GET', '/api/v1/data/it_contacts?pageSize=1');
    const contactId = ((contacts.body.data as Json[])[0] as Json).id as string;
    const patched = await api('PATCH', `/api/v1/data/it_contacts/${contactId}`, { age: 86 });
    expect(patched.status).toBe(200);

    // The failure lands in the ledger with an error and a scheduled retry.
    const failed = await eventually(async () => {
      const res = await api('GET', `/api/v1/events/deliveries?consumer=${consumer}&status=failed`);
      const rows = res.body.data as Json[];
      return rows.length > 0 ? rows[0] : undefined;
    });
    expect(failed.error).toBeTruthy();
    expect(failed.nextAttemptAt).toBeTruthy();

    // The downstream "recovers"; revive the delivery through the DLQ endpoint
    // (without it, the next attempt would wait out the exponential backoff).
    healthy = true;
    const retry = await api('POST', '/api/v1/events/deliveries/retry', {
      eventId: failed.eventId,
      consumer,
    });
    expect(retry.status).toBe(202);

    const done = await eventually(async () => {
      const res = await api('GET', `/api/v1/events/deliveries?consumer=${consumer}&status=done`);
      const rows = res.body.data as Json[];
      return rows.length > 0 ? rows[0] : undefined;
    });
    expect(done.eventId).toBe(failed.eventId);

    await api('DELETE', `/api/v1/webhooks/${hookId}`);
    failing.close();
  });

  it('streams realtime events over SSE with API-key auth', async () => {
    if (!app) throw new Error('Server not booted');
    // The SSE stream needs a real socket (inject cannot consume an open
    // stream) — bind to an ephemeral port for this test only.
    const address = await app.server.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${address}/api/v1/events/stream?topics=data.it_contacts.*`, {
      headers: { accept: 'text/event-stream', 'x-api-key': auth.apiKey },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No stream body');
    const decoder = new TextDecoder();

    // Cause a change, then read frames until its event arrives.
    await api('POST', '/api/v1/data/it_contacts', {
      full_name: 'Streamed Row',
      email: 'stream@ion.test',
    });

    let buffer = '';
    const frame = await eventually(async () => {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream closed early');
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.split(/\n\n/).find((f) => f.includes('data.it_contacts.created'));
      return match;
    });
    const data = frame
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5);
    const event = JSON.parse(data ?? '{}') as Json;
    expect(event.topic).toBe('data.it_contacts.created');
    expect((event.payload as Json).object).toBe('it_contacts');
    expect(((event.payload as Json).actor as Json).userId).toBe(auth.userId);

    await reader.cancel();
    // Anonymous connections are rejected while enforcement is on.
    const anon = await fetch(`${address}/api/v1/events/stream`);
    expect(anon.status).toBe(401);
    await anon.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// Phase 13 — relational completeness (links, reverse expand, GraphQL edge,
// removeRelationship)
// ---------------------------------------------------------------------------

/** The already-listening test socket (bound by the SSE test above). */
function liveAddress(): string {
  if (!app) throw new Error('Server not booted');
  const bound = app.server.server.address() as AddressInfo | null;
  if (!bound) throw new Error('Server is not listening (SSE test must run first)');
  return `http://127.0.0.1:${bound.port}`;
}

describe('relational completeness (Phase 13)', () => {
  const tagIds: string[] = [];
  let tinaId = '';

  it('writes many_to_many links idempotently and hydrates both directions', async () => {
    const tags = await api('POST', '/api/v1/schema/objects', {
      name: 'it_tags',
      displayName: 'IT Tags',
      fields: [{ name: 'label', displayName: 'Label', columnType: 'text', isRequired: true }],
    });
    expect(tags.status).toBe(201);

    const rel = await api('POST', '/api/v1/schema/relationships', {
      name: 'tags',
      displayName: 'Tags',
      type: 'many_to_many',
      sourceObjectName: 'it_contacts',
      targetObjectName: 'it_tags',
    });
    expect(rel.status).toBe(201);

    for (const label of ['vip', 'beta']) {
      const created = await api('POST', '/api/v1/data/it_tags', { label });
      tagIds.push((created.body.data as Json).id as string);
    }
    const tina = await api('POST', '/api/v1/data/it_contacts', { full_name: 'Tagged Tina' });
    tinaId = (tina.body.data as Json).id as string;

    // Link both tags; a replay adds nothing (composite-PK idempotency).
    const linked = await api('POST', `/api/v1/data/it_contacts/${tinaId}/links/tags`, {
      ids: tagIds,
    });
    expect(linked.status).toBe(200);
    expect((linked.body.data as Json).added).toBe(2);
    const replay = await api('POST', `/api/v1/data/it_contacts/${tinaId}/links/tags`, {
      ids: [tagIds[0]],
    });
    expect((replay.body.data as Json).added).toBe(0);

    // Forward expand (contacts → tags) and the m2m key from the other side.
    const withTags = await api('GET', `/api/v1/data/it_contacts/${tinaId}?expand=tags`);
    const tagList = (withTags.body.data as Json).tags as Json[];
    expect(tagList.map((t) => t.label).sort()).toEqual(['beta', 'vip']);
    const fromTag = await api('GET', `/api/v1/data/it_tags/${tagIds[0]}?expand=tags`);
    expect(((fromTag.body.data as Json).tags as Json[]).map((c) => c.full_name)).toContain(
      'Tagged Tina',
    );

    // Reverse FK expand: companies list their FK-holding contacts.
    const companies = await api('GET', '/api/v1/data/it_companies?expand=it_contacts_by_company');
    const acme = (companies.body.data as Json[]).find((c) => c.name === 'Acme Corp') as Json;
    expect((acme.it_contacts_by_company as Json[]).map((c) => c.full_name)).toContain(
      'Linked Larry',
    );

    // Unlink one; the change is visible and only net changes are reported.
    const unlinked = await api('DELETE', `/api/v1/data/it_contacts/${tinaId}/links/tags`, {
      ids: [tagIds[1]],
    });
    expect((unlinked.body.data as Json).removed).toBe(1);
    const after = await api('GET', `/api/v1/data/it_contacts/${tinaId}?expand=tags`);
    expect(((after.body.data as Json).tags as Json[]).map((t) => t.label)).toEqual(['vip']);

    // Friendly 400s: unknown target id and non-m2m relationship.
    const ghost = await api('POST', `/api/v1/data/it_contacts/${tinaId}/links/tags`, {
      ids: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(ghost.status).toBe(400);
    expect(ghost.body.error).toBe('UNKNOWN_TARGET');
    const notM2m = await api('POST', `/api/v1/data/it_contacts/${tinaId}/links/company`, {
      ids: [tagIds[0]],
    });
    expect(notM2m.status).toBe(400);
    expect(notM2m.body.error).toBe('NOT_MANY_TO_MANY');

    // The junction writes rode the transactional outbox.
    if (!scratchClient) throw new Error('Scratch client not connected');
    const linkEvents = await scratchClient.query(
      "SELECT topic, payload FROM _ion_events WHERE topic IN ('data.it_contacts.linked', 'data.it_contacts.unlinked')",
    );
    const topics = linkEvents.rows.map((r) => r.topic as string);
    expect(topics).toContain('data.it_contacts.linked');
    expect(topics).toContain('data.it_contacts.unlinked');
    const linkPayload = linkEvents.rows.find((r) => r.topic === 'data.it_contacts.linked')
      ?.payload as Json;
    expect(linkPayload.relationship).toBe('tags');
    expect(linkPayload.targetObject).toBe('it_tags');
    expect((linkPayload.actor as Json).userId).toBe(auth.userId);
  });

  it('traverses relationships in GraphQL (batched) and mutates links', async () => {
    const res = await api('POST', '/api/v1/graphql', {
      query: `query {
        it_companies {
          data { name it_contacts_by_company { full_name company { name } } }
        }
        it_contacts(search: "Tagged") { data { full_name tags { label } } }
      }`,
    });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const companies = ((res.body.data as Json).it_companies as Json).data as Json[];
    const acme = companies.find((c) => c.name === 'Acme Corp') as Json;
    const larry = (acme.it_contacts_by_company as Json[]).find(
      (c) => c.full_name === 'Linked Larry',
    ) as Json;
    // Round-trip: the child's own FK field traverses back to the parent.
    expect((larry.company as Json).name).toBe('Acme Corp');
    const tina = (((res.body.data as Json).it_contacts as Json).data as Json[])[0] as Json;
    expect((tina.tags as Json[]).map((t) => t.label)).toEqual(['vip']);

    // Link mutations run the same DataService path.
    const mutation = await api('POST', '/api/v1/graphql', {
      query: `mutation Link($id: ID!, $ids: [ID!]!) {
        link_it_contacts_tags(id: $id, ids: $ids)
      }`,
      variables: { id: tinaId, ids: [tagIds[1]] },
    });
    expect(mutation.body.errors).toBeUndefined();
    expect((mutation.body.data as Json).link_it_contacts_tags).toBe(1);
    const unlink = await api('POST', '/api/v1/graphql', {
      query: `mutation Unlink($id: ID!, $ids: [ID!]!) {
        unlink_it_contacts_tags(id: $id, ids: $ids)
      }`,
      variables: { id: tinaId, ids: [tagIds[1]] },
    });
    expect((unlink.body.data as Json).unlink_it_contacts_tags).toBe(1);
  });

  it('rejects queries past the traversal depth cap', async () => {
    // 3 base levels + 6x2 traversal levels = 15 > the 12-level cap.
    const hops = 'it_contacts_by_company { company { '.repeat(6);
    const closes = '} } '.repeat(6);
    const res = await api('POST', '/api/v1/graphql', {
      query: `query { it_companies { data { ${hops} name ${closes} } } }`,
    });
    const errors = res.body.errors as Json[];
    expect(errors?.[0]?.message).toContain('exceeds the maximum allowed depth');
  });

  it('serves Subscription.events over GraphQL-SSE with per-event delivery', async () => {
    const address = liveAddress();
    const res = await fetch(`${address}/api/v1/graphql`, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'x-api-key': auth.apiKey,
      },
      body: JSON.stringify({
        query: 'subscription { events(topics: ["data.it_contacts.*"]) { id topic payload } }',
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No subscription body');
    const decoder = new TextDecoder();

    // Give the subscribe resolver a beat to attach, then cause a change.
    await new Promise((r) => setTimeout(r, 200));
    await api('POST', '/api/v1/data/it_contacts', { full_name: 'Subscribed Sam' });

    // The bridge's 5s overlap window may replay this run's recent events
    // first (best-effort feed semantics) — scan for exactly our event.
    let buffer = '';
    const frame = await eventually(async () => {
      const { value, done } = await reader.read();
      if (done) throw new Error('GraphQL-SSE stream closed early');
      buffer += decoder.decode(value, { stream: true });
      return buffer
        .split(/\n\n/)
        .find((f) => f.includes('data.it_contacts.created') && f.includes('Subscribed Sam'));
    });
    const data = frame
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5);
    const payload = JSON.parse(data ?? '{}') as Json;
    const event = ((payload.data as Json)?.events ?? {}) as Json;
    expect(event.topic).toBe('data.it_contacts.created');
    expect(((event.payload as Json).after as Json).full_name).toBe('Subscribed Sam');
    await reader.cancel();
  });

  it('exposes installed block actions as GraphQL mutations', async () => {
    // Re-install the Phase 14 logic block (its handlers stay registered).
    const install = await api('POST', '/api/v1/blocks/install', {
      manifest: {
        name: 'it_logic',
        version: '0.0.1',
        title: 'Integration Logic Block',
        objects: [
          {
            name: 'it_widgets',
            displayName: 'IT Widgets',
            fields: [{ name: 'label', displayName: 'Label', columnType: 'text', isRequired: true }],
          },
        ],
        actions: [{ name: 'stamp', description: 'Creates a widget with a stamped label.' }],
        hooks: [{ name: 'echo' }],
      },
    });
    expect(install.status).toBe(201);

    const res = await api('POST', '/api/v1/graphql', {
      query: 'mutation { it_logic_stamp(input: { label: "gql" }) }',
    });
    expect(res.body.errors).toBeUndefined();
    expect(((res.body.data as Json).it_logic_stamp as Json).label).toBe('stamped:gql');

    await api('DELETE', '/api/v1/blocks/it_logic?dropData=true');
  });

  it('removes relationships preview-first, dropping the junction / FK column', async () => {
    // m2m: the dry run names the doomed link rows and the junction drop.
    const preview = await api(
      'DELETE',
      '/api/v1/schema/objects/it_contacts/relationships/tags?dryRun=true',
    );
    expect(preview.status).toBe(200);
    const previewData = preview.body.data as Json;
    expect(previewData.isValid).toBe(true);
    expect((previewData.sqlStatements as string[]).join()).toContain('DROP TABLE IF EXISTS');
    expect(
      (previewData.warnings as Json[]).some((w) => String(w.message).includes('link row')),
    ).toBe(true);

    const removed = await api('DELETE', '/api/v1/schema/objects/it_contacts/relationships/tags');
    expect(removed.status).toBe(200);
    if (!scratchClient) throw new Error('Scratch client not connected');
    const junction = await scratchClient.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'it_contacts_it_tags'",
    );
    expect(junction.rows[0].n).toBe(0);
    // The expand key is gone; unknown keys stay lenient.
    const row = await api('GET', `/api/v1/data/it_contacts/${tinaId}?expand=tags`);
    expect((row.body.data as Json).tags).toBeUndefined();

    // FK-backed: preview warns about stored links, execution drops the column.
    const fkPreview = await api(
      'DELETE',
      '/api/v1/schema/objects/it_contacts/relationships/company?dryRun=true',
    );
    expect(
      ((fkPreview.body.data as Json).warnings as Json[]).some((w) =>
        String(w.message).includes('company_id'),
      ),
    ).toBe(true);
    const fkRemoved = await api(
      'DELETE',
      '/api/v1/schema/objects/it_contacts/relationships/company',
    );
    expect(fkRemoved.status).toBe(200);
    const contacts = await api('GET', '/api/v1/schema/objects/it_contacts');
    const fieldNames = ((contacts.body.data as Json).fields as Json[]).map((f) => f.name);
    expect(fieldNames).not.toContain('company_id');

    // Unknown relationship (or wrong source object) → 422 with the error code.
    const missing = await api(
      'DELETE',
      '/api/v1/schema/objects/it_companies/relationships/company',
    );
    expect(missing.status).toBe(422);
  });
});
