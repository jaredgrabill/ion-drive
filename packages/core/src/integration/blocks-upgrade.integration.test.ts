/**
 * Spec-07 integration suite — the block upgrade story against real Postgres,
 * mirroring the acceptance-1 scenario:
 *
 *   1. install an inline block @0.2.0 (task + constrained field + vendored
 *      code the server ignores)
 *   2. dry-run upgrade to 0.3.0 (adds a field, tightens a constraint, removes
 *      a task + a field) → delta + previews, nothing changed
 *   3. real upgrade → field + constraint applied (information_schema +
 *      constraint probe), the removed task SURVIVES (skippedDestructive), the
 *      removed field is released to `user` management
 *   4. equal-version re-POST → 200 no-op; downgrade → 409 with recovery
 *   5. partial-state re-run: half the 0.4.0 delta pre-applied by hand, then
 *      upgrade completes cleanly (the skip-and-report property, AC4)
 *   6. force path: 0.5.0 removes a field + the task → applied for real
 *   7. ledger: version, manifest snapshot, digest replaced
 *
 * Plus the spec-06 regression rider: deleting an object with a live
 * many_to_many relationship also drops the junction table.
 *
 * Run with a reachable Postgres (same contract as the platform suite):
 *   ION_DATABASE_URL=… pnpm --filter @ion-drive/core test:integration
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';
const SCRATCH_DB = `ion_it_${randomBytes(6).toString('hex')}`;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

type IonApp = Awaited<ReturnType<typeof createServer>>;
type Json = Record<string, unknown>;

let adminClient: pg.Client | undefined;
let scratchClient: pg.Client | undefined;
let app: IonApp | undefined;

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {} };
}

/** Column names of `table` from information_schema. */
async function columnsOf(table: string): Promise<string[]> {
  if (!scratchClient) throw new Error('scratch client missing');
  const res = await scratchClient.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table],
  );
  return res.rows.map((r) => String(r.column_name));
}

async function tableExists(table: string): Promise<boolean> {
  if (!scratchClient) throw new Error('scratch client missing');
  const res = await scratchClient.query(
    'SELECT 1 FROM information_schema.tables WHERE table_name = $1',
    [table],
  );
  return res.rowCount !== null && res.rowCount > 0;
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
  // Auth off: this suite exercises the upgrade engine, not RBAC (the platform
  // suite covers guards); rate limiting off so request bursts never 429.
  app = await createServer({
    databaseUrl: scratchUrl(),
    requireAuth: false,
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
  // Wait for pg-pool stragglers before dropping (see the platform suite).
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const res = await adminClient?.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [SCRATCH_DB],
    );
    if (res?.rows[0].n === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await adminClient?.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await adminClient?.end();
}, 60_000);

// ---------------------------------------------------------------------------
// Manifest fixtures
// ---------------------------------------------------------------------------

const itemsObject = (fields: Record<string, unknown>[]) => ({
  name: 'up_items',
  displayName: 'Upgrade Items',
  fields,
});

const qty = (max: number) => ({
  name: 'qty',
  displayName: 'Qty',
  columnType: 'integer',
  constraints: { min: 0, max },
});

const v020 = {
  name: 'up_demo',
  version: '0.2.0',
  title: 'Upgrade Demo',
  objects: [
    itemsObject([
      { name: 'label', displayName: 'Label', columnType: 'text' },
      { name: 'legacy_note', displayName: 'Legacy Note', columnType: 'text' },
      qty(100),
    ]),
  ],
  tasks: [{ name: 'up-demo-task', type: 'noop', schedule: '0 0 * * *', enabled: false }],
  code: [{ path: 'index.ts', contents: '// noop v0.2.0\n' }],
};

const v030 = {
  ...v020,
  version: '0.3.0',
  objects: [
    itemsObject([
      { name: 'label', displayName: 'Label', columnType: 'text' },
      { name: 'status', displayName: 'Status', columnType: 'text', defaultValue: 'new' },
      qty(50),
    ]),
  ],
  tasks: [],
  code: [{ path: 'index.ts', contents: '// noop v0.3.0\n' }],
};

const v040 = {
  ...v030,
  version: '0.4.0',
  // Re-declared (additive) so the 0.5.0 boundary can drop it under force —
  // the 0.3.0 no-force upgrade left the original orphaned on purpose.
  tasks: [{ name: 'up-demo-task', type: 'noop', schedule: '0 0 * * *', enabled: false }],
  objects: [
    itemsObject([
      { name: 'label', displayName: 'Label', columnType: 'text' },
      { name: 'status', displayName: 'Status', columnType: 'text', defaultValue: 'new' },
      { name: 'priority', displayName: 'Priority', columnType: 'integer' },
      { name: 'owner_note', displayName: 'Owner Note', columnType: 'text' },
      qty(50),
    ]),
  ],
};

const v050 = {
  ...v040,
  version: '0.5.0',
  tasks: [],
  objects: [
    itemsObject([
      { name: 'label', displayName: 'Label', columnType: 'text' },
      { name: 'priority', displayName: 'Priority', columnType: 'integer' },
      { name: 'owner_note', displayName: 'Owner Note', columnType: 'text' },
      qty(50),
    ]),
  ],
};

const digestFor = (tag: string) => `sha256:${tag.repeat(64).slice(0, 64)}`;

describe('block upgrade lifecycle (spec-07)', () => {
  it('installs 0.2.0 and seeds a row', async () => {
    const install = await api('POST', '/api/v1/blocks/install', {
      manifest: v020,
      source: { digest: digestFor('a') },
    });
    expect(install.status).toBe(201);
    expect((install.body.data as Json).objectsCreated).toEqual(['up_items']);
    expect((install.body.data as Json).tasksCreated).toEqual(['up-demo-task']);

    const row = await api('POST', '/api/v1/data/up_items', { label: 'first', qty: 10 });
    expect(row.status).toBe(201);
  });

  it('dry-runs the 0.3.0 upgrade: delta + previews, nothing applied', async () => {
    const dry = await api('POST', '/api/v1/blocks/install?upgrade=true&dryRun=true', {
      manifest: v030,
    });
    expect(dry.status).toBe(200);
    const report = dry.body.data as Json;
    expect(report.upgraded).toEqual({ from: '0.2.0', to: '0.3.0' });

    const delta = report.delta as Json;
    const fields = delta.fields as Json[];
    const byName = new Map(fields.map((f) => [f.fieldName, f]));
    expect(byName.get('status')?.kind).toBe('additive');
    expect(byName.get('legacy_note')?.kind).toBe('destructive');
    expect(byName.get('qty')?.kind).toBe('modifying');
    expect((delta.tasks as Json[]).map((t) => `${t.name}:${t.kind}`)).toEqual([
      'up-demo-task:destructive',
    ]);
    expect((delta.code as Json).changed).toEqual(['index.ts']);

    const previews = report.previews as Json[];
    expect(previews.map((p) => p.target)).toEqual(
      expect.arrayContaining(['add field up_items.status', 'field up_items.qty']),
    );
    const qtyPreview = previews.find((p) => p.target === 'field up_items.qty');
    expect((qtyPreview?.sqlStatements as string[]).join('\n')).toContain('CHECK');

    // Nothing changed: the column is absent and the ledger still shows 0.2.0.
    expect(await columnsOf('up_items')).not.toContain('status');
    const ledger = await api('GET', '/api/v1/blocks/up_demo');
    expect((ledger.body.data as Json).version).toBe('0.2.0');
  });

  it('applies 0.3.0: new field + tightened constraint; removed task/field skipped + released', async () => {
    const up = await api('POST', '/api/v1/blocks/install?upgrade=true', {
      manifest: v030,
      source: { digest: digestFor('b') },
    });
    expect(up.status).toBe(201);
    const report = up.body.data as Json;
    expect(report.skippedDestructive).toEqual(
      expect.arrayContaining([
        'task "up-demo-task" (removed in 0.3.0)',
        'field "up_items.legacy_note" (removed in 0.3.0)',
      ]),
    );
    expect(report.released).toEqual(['field "up_items.legacy_note"']);

    // The added column exists; the kept row survived.
    expect(await columnsOf('up_items')).toEqual(expect.arrayContaining(['status', 'legacy_note']));
    const rows = await api('GET', '/api/v1/data/up_items');
    expect((rows.body.data as Json[]).length).toBe(1);

    // Constraint probe: qty over the tightened max is a friendly 400.
    const bad = await api('POST', '/api/v1/data/up_items', { label: 'x', qty: 80 });
    expect(bad.status).toBe(400);
    const ok = await api('POST', '/api/v1/data/up_items', { label: 'y', qty: 40 });
    expect(ok.status).toBe(201);

    // The removed task SURVIVES without force.
    const tasks = await api('GET', '/api/v1/tasks');
    expect((tasks.body.data as Json[]).map((t) => t.name)).toContain('up-demo-task');

    // The released field flipped to user management.
    const obj = await api('GET', '/api/v1/schema/objects/up_items');
    const legacy = ((obj.body.data as Json).fields as Json[]).find((f) => f.name === 'legacy_note');
    expect(legacy?.managedBy).toBe('user');

    // Ledger: version + snapshot + digest replaced.
    const ledger = (await api('GET', '/api/v1/blocks/up_demo')).body.data as Json;
    expect(ledger.version).toBe('0.3.0');
    expect((ledger.manifest as Json).version).toBe('0.3.0');
    expect(ledger.artifactDigest).toBe(digestFor('b'));
    expect(ledger.createdObjects).toEqual(['up_items']);
  });

  it('answers an equal-version re-POST as a 200 no-op and refuses a downgrade with recovery', async () => {
    const noop = await api('POST', '/api/v1/blocks/install?upgrade=true', {
      manifest: v030,
      source: { digest: digestFor('b') },
    });
    expect(noop.status).toBe(200);
    expect(((noop.body.data as Json).warnings as string[])[0]).toContain('nothing to do');

    const down = await api('POST', '/api/v1/blocks/install?upgrade=true', { manifest: v020 });
    expect(down.status).toBe(409);
    expect(down.body.code).toBe('NOT_AN_UPGRADE');
    expect(String(down.body.message)).toContain('ion-drive remove up_demo');
  });

  it('completes cleanly over a partially-applied delta (AC4: skip-and-report)', async () => {
    // Pre-apply half of 0.4.0 by hand: the "priority" field already exists.
    const preApply = await api('POST', '/api/v1/schema/objects/up_items/fields', {
      name: 'priority',
      displayName: 'Priority',
      columnType: 'integer',
    });
    expect(preApply.status).toBe(201);

    const up = await api('POST', '/api/v1/blocks/install?upgrade=true', { manifest: v040 });
    expect(up.status).toBe(201);
    const report = up.body.data as Json;
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('"up_items.priority" already exists')]),
    );
    expect(await columnsOf('up_items')).toEqual(expect.arrayContaining(['priority', 'owner_note']));
    expect(((await api('GET', '/api/v1/blocks/up_demo')).body.data as Json).version).toBe('0.4.0');
  });

  it('force applies destructive changes: field + task removed for real', async () => {
    const up = await api('POST', '/api/v1/blocks/install?upgrade=true&force=true', {
      manifest: v050,
    });
    expect(up.status).toBe(201);
    const report = up.body.data as Json;
    expect(report.skippedDestructive).toEqual([]);
    expect(report.tasksRemoved).toEqual(['up-demo-task']);

    expect(await columnsOf('up_items')).not.toContain('status');
    const tasks = await api('GET', '/api/v1/tasks');
    expect((tasks.body.data as Json[]).map((t) => t.name)).not.toContain('up-demo-task');
  });

  it('uninstalls cleanly afterwards', async () => {
    const gone = await api('DELETE', '/api/v1/blocks/up_demo?dropData=true');
    expect(gone.status).toBe(200);
    expect(await tableExists('up_items')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — failure injection + re-run of the SAME upgrade (the verifier repro):
// a mid-way failure must leave the ledger's PRIOR version + snapshot in place
// (status `failed`) so that, once the cause is fixed, re-running the same
// upgrade recomputes the same delta and completes.
// ---------------------------------------------------------------------------

describe('upgrade failure + re-run (AC4)', () => {
  const fd = (fields: Record<string, unknown>[]) => ({
    name: 'fail_demo',
    version: '0.1.0',
    title: 'Fail Demo',
    objects: [{ name: 'fd_items', displayName: 'FD Items', fields }],
  });
  const fdLabel = { name: 'label', displayName: 'Label', columnType: 'text' };
  const fd010 = fd([fdLabel, { name: 'note', displayName: 'Note', columnType: 'text' }]);
  const fd020 = {
    ...fd([
      fdLabel,
      // Tightens to required WITHOUT a defaultValue — with a NULL row live,
      // the REQUIRES_BACKFILL guard fails this step on purpose.
      { name: 'note', displayName: 'Note', columnType: 'text', isRequired: true },
      { name: 'extra', displayName: 'Extra', columnType: 'text' },
    ]),
    version: '0.2.0',
  };

  let rowId = '';

  it('fails mid-way with the actionable re-run message, preserving the ledger anchor', async () => {
    const install = await api('POST', '/api/v1/blocks/install', { manifest: fd010 });
    expect(install.status).toBe(201);
    // A NULL `note` row makes the isRequired tightening impossible as-is.
    const row = await api('POST', '/api/v1/data/fd_items', { label: 'nullable' });
    expect(row.status).toBe(201);
    rowId = String((row.body.data as Json).id);

    const failed = await api('POST', '/api/v1/blocks/install?upgrade=true', { manifest: fd020 });
    expect(failed.status).toBe(500);
    expect(String(failed.body.message)).toContain('re-run the upgrade');

    // Begin-with-old/finish-with-new: the row still anchors 0.1.0 (snapshot
    // included) with status `failed` — NOT the half-applied target version.
    const ledger = (await api('GET', '/api/v1/blocks/fail_demo')).body.data as Json;
    expect(ledger.version).toBe('0.1.0');
    expect(ledger.status).toBe('failed');
    expect((ledger.manifest as Json).version).toBe('0.1.0');
    // The failing step ran before the additive one — nothing else applied.
    expect(await columnsOf('fd_items')).not.toContain('extra');
  });

  it('completes the SAME upgrade after the data is fixed', async () => {
    const fix = await api('PATCH', `/api/v1/data/fd_items/${rowId}`, { note: 'fixed' });
    expect(fix.status).toBe(200);

    const rerun = await api('POST', '/api/v1/blocks/install?upgrade=true', { manifest: fd020 });
    expect(rerun.status).toBe(201);
    const report = rerun.body.data as Json;
    expect(report.upgraded).toEqual({ from: '0.1.0', to: '0.2.0' });

    // The tightening and the added field both landed.
    if (!scratchClient) throw new Error('scratch client missing');
    const note = await scratchClient.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'fd_items' AND column_name = 'note'",
    );
    expect(note.rows[0]?.is_nullable).toBe('NO');
    expect(await columnsOf('fd_items')).toContain('extra');

    const ledger = (await api('GET', '/api/v1/blocks/fail_demo')).body.data as Json;
    expect(ledger.version).toBe('0.2.0');
    expect(ledger.status).toBe('installed');
    expect((ledger.manifest as Json).version).toBe('0.2.0');

    expect((await api('DELETE', '/api/v1/blocks/fail_demo?dropData=true')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Spec-06 regression rider: deleting an object with a live m2m relationship
// must drop the junction table too (SchemaManager.deleteObject fix).
// ---------------------------------------------------------------------------

describe('junction cleanup on object delete (spec-06 rider)', () => {
  it('drops the junction table when a linked object is deleted', async () => {
    for (const name of ['jt_posts', 'jt_tags']) {
      const created = await api('POST', '/api/v1/schema/objects', {
        name,
        displayName: name,
        fields: [{ name: 'title', displayName: 'Title', columnType: 'text' }],
      });
      expect(created.status).toBe(201);
    }
    const rel = await api('POST', '/api/v1/schema/relationships', {
      name: 'tags',
      displayName: 'Tags',
      type: 'many_to_many',
      sourceObjectName: 'jt_posts',
      targetObjectName: 'jt_tags',
    });
    expect(rel.status).toBe(201);

    // Live link rows through the junction.
    const post = (await api('POST', '/api/v1/data/jt_posts', { title: 'p' })).body.data as Json;
    const tag = (await api('POST', '/api/v1/data/jt_tags', { title: 't' })).body.data as Json;
    const link = await api('POST', `/api/v1/data/jt_posts/${post.id}/links/tags`, {
      ids: [tag.id],
    });
    expect(link.status).toBe(200);
    expect(await tableExists('jt_posts_jt_tags')).toBe(true);

    const del = await api('DELETE', '/api/v1/schema/objects/jt_posts');
    expect(del.status).toBe(200);
    expect(await tableExists('jt_posts_jt_tags')).toBe(false);

    await api('DELETE', '/api/v1/schema/objects/jt_tags');
  });
});
