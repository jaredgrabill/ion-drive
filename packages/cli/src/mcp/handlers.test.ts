/**
 * Unit tests for the registry MCP handlers (spec-08 §4 / AC4) — straight
 * function calls, no transport: search_blocks (search-index path + fallback),
 * get_block (with/without an advertised README), list_registries (reachable +
 * error rows), preview_install (plan shape, dependency closure, deprecated
 * warnings, digest mismatch → typed IntegrityError, unreachable-server
 * degradation), and the AC4 **parity test** proving `preview_install` and
 * `ion-drive add --dry-run` report the same plan + trust verdicts through the
 * shared `buildVerifiedPlan` pipeline.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IonApiClient } from '../api-client.js';
import { addCommand } from '../commands/add.js';
import { type IonProjectConfig, resetConfigWarnings } from '../config.js';
import { buildVerifiedPlan, gatherServerState } from '../registry/preview.js';
import { resetRegistryCache } from '../registry/registry-client.js';
import { IntegrityError, computeDigest, packBytes } from '../registry/verify.js';
import { createRegistryMcpHandlers, projectVerifiedItem } from './handlers.js';

// --- Fixture registry (digests computed over the exact artifact bytes) ------

const BASE = 'http://localhost:9700';
const INDEX_URL = `${BASE}/registry/index.json`;

const CRM_MANIFEST = { name: 'crm', version: '0.2.0', title: 'CRM', objects: [] };
const INVOICING_MANIFEST = {
  name: 'invoicing',
  version: '0.3.0',
  title: 'Invoicing',
  dependencies: { crm: '^0.2.0' },
  objects: [],
};

const CRM_BYTES = packBytes(CRM_MANIFEST);
const INVOICING_BYTES = packBytes(INVOICING_MANIFEST);

const README = '# Invoicing\n\nInvoices, line items, Stripe payment links.\n';

const versionEntry = (
  name: string,
  version: string,
  bytes: Uint8Array,
  extra: Record<string, unknown> = {},
) => ({
  artifactUrl: `../../${name}/dist/${version}/block.json`,
  digest: computeDigest(bytes),
  size: bytes.byteLength,
  publishedAt: '2026-07-09T00:00:00Z',
  dependencies: {},
  requires: {},
  status: 'active',
  ...extra,
});

const INDEX = {
  schemaVersion: 1,
  name: 'Fixture Registry',
  generatedAt: '2026-07-09T00:00:00Z',
  searchUrl: 'search-index.json',
  blocks: {
    crm: { title: 'CRM', latest: '0.2.0', blockUrl: 'blocks/crm.json' },
    invoicing: {
      title: 'Invoicing',
      description: 'Invoices and Stripe payment links.',
      latest: '0.3.0',
      blockUrl: 'blocks/invoicing.json',
    },
  },
};

const SEARCH_INDEX = {
  schemaVersion: 1,
  generatedAt: '2026-07-09T00:00:00Z',
  documents: [
    { name: 'crm', title: 'CRM', latest: '0.2.0' },
    {
      name: 'invoicing',
      title: 'Invoicing',
      description: 'Invoices and Stripe payment links.',
      latest: '0.3.0',
    },
  ],
};

const CRM_DOC = {
  schemaVersion: 1,
  name: 'crm',
  title: 'CRM',
  latest: '0.2.0',
  versions: {
    '0.2.0': versionEntry('crm', '0.2.0', CRM_BYTES, {
      status: 'deprecated',
      statusReason: 'superseded soon',
    }),
  },
  advisories: [],
};

const INVOICING_DOC = {
  schemaVersion: 1,
  name: 'invoicing',
  title: 'Invoicing',
  readmeUrl: 'invoicing.readme.md',
  latest: '0.3.0',
  versions: {
    '0.3.0': versionEntry('invoicing', '0.3.0', INVOICING_BYTES, {
      dependencies: { crm: '^0.2.0' },
    }),
  },
  advisories: [],
};

/** Routes for the injected fetchImpl: objects → JSON, Uint8Array/string → raw. */
function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [INDEX_URL]: INDEX,
    [`${BASE}/registry/search-index.json`]: SEARCH_INDEX,
    [`${BASE}/registry/blocks/crm.json`]: CRM_DOC,
    [`${BASE}/registry/blocks/invoicing.json`]: INVOICING_DOC,
    [`${BASE}/registry/blocks/invoicing.readme.md`]: README,
    [`${BASE}/crm/dist/0.2.0/block.json`]: CRM_BYTES,
    [`${BASE}/invoicing/dist/0.3.0/block.json`]: INVOICING_BYTES,
    ...overrides,
  };
}

function fakeFetch(table: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input).split('?')[0] ?? '';
    const body = table[url];
    if (body === undefined) throw new TypeError(`fetch failed (unstubbed: ${url})`);
    if (body instanceof Uint8Array) {
      return new Response(new Uint8Array(body), { status: 200 });
    }
    if (typeof body === 'string') return new Response(body, { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const CONFIG: IonProjectConfig = {
  serverUrl: 'http://localhost:9750',
  registries: { '@ion': INDEX_URL },
  blocks: [],
};

/** A structural fake of the server client (health + installed list). */
function fakeClient(opts: { unreachable?: boolean; installed?: [string, string][] } = {}) {
  return {
    async health() {
      if (opts.unreachable) throw Object.assign(new Error('ECONNREFUSED'), { name: 'ApiError' });
      return { status: 'ok', version: '0.3.0', objectCount: 0 };
    },
    async listInstalled() {
      return (opts.installed ?? []).map(([name, version]) => ({
        name,
        version,
        title: name,
        status: 'installed',
        createdObjects: [],
        installedAt: '2026-07-09T00:00:00Z',
      }));
    },
  } as unknown as IonApiClient;
}

let cacheDir: string;

beforeEach(() => {
  // Isolate the disk cache from the developer's real ~/.ion-drive.
  cacheDir = mkdtempSync(join(tmpdir(), 'ion-mcp-cache-'));
  vi.stubEnv('ION_DRIVE_CACHE_DIR', cacheDir);
  resetRegistryCache();
  resetConfigWarnings();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(cacheDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

function handlers(overrides: Record<string, unknown> = {}, client = fakeClient()) {
  return createRegistryMcpHandlers({
    config: CONFIG,
    fetchImpl: fakeFetch(routes(overrides)),
    client,
    noCache: true,
  });
}

describe('search_blocks', () => {
  it('searches via the advertised search index', async () => {
    const result = await handlers().search_blocks({ term: 'invoi' });
    expect(result.source).toBe('search-index');
    expect(result.hits.map((h) => h.name)).toEqual(['invoicing']);
    expect(result.term).toBe('invoi');
  });

  it('falls back to the index when no searchUrl is advertised', async () => {
    const result = await handlers({
      [INDEX_URL]: { ...INDEX, searchUrl: undefined },
    }).search_blocks({ term: 'stripe' });
    expect(result.source).toBe('index');
    expect(result.hits).toEqual([
      expect.objectContaining({ name: 'invoicing', matchedVia: 'description' }),
    ]);
  });
});

describe('get_block', () => {
  it('returns the block doc with the README inlined when advertised', async () => {
    const result = await handlers().get_block({ name: 'invoicing' });
    expect(result.registry).toBe('@ion');
    expect(result.block).toMatchObject({ name: 'invoicing', latest: '0.3.0' });
    expect(result.readme).toBe(README);
    expect(result.warnings).toEqual([]);
  });

  it('omits the README (no error) when the doc advertises none', async () => {
    const result = await handlers().get_block({ name: 'crm' });
    expect(result.block).toMatchObject({ name: 'crm' });
    expect(result.readme).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('degrades to a warning when the advertised README is unreadable', async () => {
    const table = routes();
    delete table[`${BASE}/registry/blocks/invoicing.readme.md`];
    const result = await createRegistryMcpHandlers({
      config: CONFIG,
      fetchImpl: fakeFetch(table),
      noCache: true,
    }).get_block({ name: 'invoicing' });
    expect(result.readme).toBeUndefined();
    expect(result.warnings.join(' ')).toMatch(/readme advertised but unreadable/);
  });
});

describe('list_registries', () => {
  it('lists reachable registries with counts and unreachable ones as error rows', async () => {
    const config: IonProjectConfig = {
      ...CONFIG,
      registries: { '@ion': INDEX_URL, '@dead': 'http://localhost:9799/index.json' },
    };
    const rows = await createRegistryMcpHandlers({
      config,
      fetchImpl: fakeFetch(routes()),
      noCache: true,
    }).list_registries();
    expect(rows.find((r) => r.namespace === '@ion')).toMatchObject({
      name: 'Fixture Registry',
      blocks: 2,
      isDefault: true,
    });
    expect(rows.find((r) => r.namespace === '@dead')?.error).toBeDefined();
  });
});

describe('preview_install', () => {
  it('returns the dependency-closure plan with digests and trust verdicts, no changes', async () => {
    const result = await handlers().preview_install({ ref: 'invoicing' });
    expect(result.changesApplied).toBe(false);
    expect(result.plan.map((p) => `${p.name}@${p.version}`)).toEqual([
      'crm@0.2.0', // dependency first (topological order)
      'invoicing@0.3.0',
    ]);
    expect(result.plan[0]).toMatchObject({
      isDependency: true,
      digest: computeDigest(CRM_BYTES),
      tier: 'community', // unattested fixture
      attestationStatus: 'absent',
    });
    // The deprecated selection surfaces as an item warning.
    expect(result.plan[0]?.warnings.join(' ')).toMatch(/deprecated/);
  });

  it('prunes satisfied installed blocks', async () => {
    const result = await handlers(
      {},
      fakeClient({ installed: [['crm', '0.2.0']] }),
    ).preview_install({ ref: 'invoicing' });
    expect(result.plan.map((p) => p.name)).toEqual(['invoicing']);
    expect(result.satisfied).toEqual(['crm']);
  });

  it('a digest mismatch is a typed hard failure (no force, spec-04 AC1)', async () => {
    await expect(
      handlers({
        [`${BASE}/crm/dist/0.2.0/block.json`]: packBytes({ ...CRM_MANIFEST, tampered: true }),
      }).preview_install({ ref: 'invoicing' }),
    ).rejects.toThrow(IntegrityError);
  });

  it('an unreachable server degrades to an empty state + warning (documented divergence)', async () => {
    const result = await handlers({}, fakeClient({ unreachable: true })).preview_install({
      ref: 'invoicing',
    });
    expect(result.warnings.join(' ')).toMatch(/unreachable — previewing without installed-block/);
    expect(result.plan.map((p) => p.name)).toEqual(['crm', 'invoicing']);
  });
});

describe('preview_install ↔ add --dry-run parity (AC4)', () => {
  let dir: string;
  let cwd: string;
  let logged: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ion-mcp-parity-'));
    cwd = process.cwd();
    process.chdir(dir);
    writeFileSync(join(dir, 'ion.config.json'), `${JSON.stringify(CONFIG, null, 2)}\n`, 'utf8');
    vi.stubEnv('ION_DRIVE_CACHE_DIR', join(dir, 'registry-cache'));
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('both entry points produce identical plan items + trust verdicts', async () => {
    // Identical inputs: same fixture fetch, same server state.
    const client = fakeClient();
    const fetchImpl = fakeFetch(routes());

    // Entry point 1: the MCP handler.
    const viaMcp = await createRegistryMcpHandlers({
      config: CONFIG,
      fetchImpl,
      client,
      noCache: true,
    }).preview_install({ ref: 'invoicing' });

    // Entry point 2: the exact call `addCommand` makes (shared pipeline).
    const serverState = await gatherServerState(client, CONFIG);
    const direct = await buildVerifiedPlan('invoicing', CONFIG, {
      serverState,
      noCache: true,
      fetchImpl,
      verifyProvenance: true,
    });
    expect(viaMcp.plan).toEqual(direct.verified.map(projectVerifiedItem));
    expect(viaMcp.satisfied).toEqual(direct.plan.satisfied);

    // Entry point 2, driven end-to-end: `ion-drive add invoicing --dry-run`
    // renders the same items in the same order with the same tier words.
    const serverRoutes = {
      'http://localhost:9750/health': { status: 'ok', version: '0.3.0', objectCount: 0 },
      'http://localhost:9750/api/v1/blocks': { data: [] },
      'http://localhost:9750/api/v1/blocks/install': {
        data: {
          block: 'x',
          version: '0.0.0',
          dryRun: true,
          objectsCreated: [],
          objectsSkipped: [],
          relationshipsCreated: [],
          recordsSeeded: {},
          tasksCreated: [],
          rolesCreated: [],
          rolesSkipped: [],
          warnings: [],
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input).split('?')[0] ?? '';
        const server = (serverRoutes as Record<string, unknown>)[url];
        if (server !== undefined) return new Response(JSON.stringify(server), { status: 200 });
        return fetchImpl(input as string);
      }),
    );
    await addCommand('invoicing', { dryRun: true, yes: true, cache: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
    const text = logged.join('\n').replace(/\[[0-9;]*m/g, '');
    expect(process.exitCode).toBeUndefined();
    for (const item of viaMcp.plan) {
      expect(text).toContain(`${item.name}@${item.version}`);
      expect(text).toContain(item.tier); // the tier badge word
    }
    // Same order: crm (dependency) before invoicing.
    expect(text.indexOf('crm@0.2.0')).toBeLessThan(text.indexOf('invoicing@0.3.0'));
  });
});
