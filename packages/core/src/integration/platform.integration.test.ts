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
 *   8. block lifecycle (install → seed → guarded uninstall → dropData)
 *
 * Run with a reachable Postgres 17 (defaults match CI's service container):
 *
 *   ION_DATABASE_URL=postgresql://ion:ion@localhost:5432/ion_drive \
 *     pnpm --filter @ionshift/ion-drive-core test:integration
 *
 * The suite fails fast with a clear message when Postgres is unreachable —
 * it never silently passes.
 */

import { randomBytes } from 'node:crypto';
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
  // FORCE terminates any straggler connections (e.g. pool keep-alives).
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
    // Inline manifest — core must not depend on @ionshift/ion-drive-blocks
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
      manifest: { ...manifest, name: 'it_dependent', dependencies: ['it_missing'] },
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
