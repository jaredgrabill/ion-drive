/**
 * Unit tests for `ion-drive search` (spec-08 §2 / AC2): the search-index
 * path, the substring fallback (no `searchUrl`), the warn-and-fall-back
 * behavior on an unusable search index, the no-match friendly exit 0, the
 * machine-pure `--json` shape, and the add-hint namespacing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IonProjectConfig, resetConfigWarnings } from '../config.js';
import { resetRegistryCache } from '../registry/registry-client.js';
import { searchCommand } from './search.js';

const INDEX_URL = 'http://localhost:9700/registry/index.json';
const SEARCH_URL = 'http://localhost:9700/registry/search-index.json';

const BLOCKS = {
  invoicing: {
    title: 'Invoicing',
    description: 'Invoices, line items, and Stripe payment links.',
    categories: ['finance'],
    latest: '0.3.0',
    blockUrl: 'blocks/invoicing.json',
    trust: 'official' as const,
  },
  crm: {
    title: 'CRM',
    description: 'Companies, contacts, deals.',
    latest: '0.2.0',
    blockUrl: 'blocks/crm.json',
    trust: 'official' as const,
  },
};

const INDEX_WITH_SEARCH = {
  schemaVersion: 1,
  name: 'Fixture Registry',
  generatedAt: '2026-07-09T00:00:00Z',
  searchUrl: 'search-index.json',
  blocks: BLOCKS,
};

const INDEX_WITHOUT_SEARCH = { ...INDEX_WITH_SEARCH, searchUrl: undefined };

const SEARCH_INDEX = {
  schemaVersion: 1,
  generatedAt: '2026-07-09T00:00:00Z',
  documents: [
    {
      name: 'crm',
      title: 'CRM',
      description: 'Companies, contacts, deals.',
      latest: '0.2.0',
      trust: 'official',
    },
    {
      name: 'invoicing',
      title: 'Invoicing',
      description: 'Invoices, line items, and Stripe payment links.',
      categories: ['finance'],
      latest: '0.3.0',
      trust: 'official',
    },
  ],
};

let dir: string;
let cwd: string;
let logged: string[];

function writeCfg(config: Partial<IonProjectConfig>): void {
  writeFileSync(
    join(dir, 'ion.config.json'),
    JSON.stringify({ serverUrl: 'http://localhost:3000', blocks: [], ...config }, null, 2),
    'utf8',
  );
}

/** Everything printed, ANSI-stripped and joined. */
function output(): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return logged.join('\n').replace(/\[[0-9;]*m/g, '');
}

/** Stubs global fetch with fixed routes; un-routed URLs throw (no network). */
function stubFetch(routes: Record<string, unknown | { status: number }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input).split('?')[0] ?? '';
      const body = routes[url];
      if (body === undefined) throw new TypeError(`fetch failed (unstubbed: ${url})`);
      if (typeof body === 'object' && body !== null && 'status' in body) {
        return new Response('not found', { status: (body as { status: number }).status });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-search-cmd-'));
  cwd = process.cwd();
  process.chdir(dir);
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('ION_DRIVE_CACHE_DIR', join(dir, 'registry-cache'));
  resetRegistryCache();
  resetConfigWarnings();
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('ion-drive search', () => {
  it('finds invoicing via the advertised search index (AC2, index path)', async () => {
    writeCfg({ registries: { '@acme': INDEX_URL }, defaultRegistry: '@acme' });
    stubFetch({ [INDEX_URL]: INDEX_WITH_SEARCH, [SEARCH_URL]: SEARCH_INDEX });
    await searchCommand('invoi', { json: true });
    expect(process.exitCode).toBeUndefined();
    const payload = JSON.parse(output()) as {
      source: string;
      hits: { name: string; matchedVia: string; addRef: string }[];
    };
    expect(payload.source).toBe('search-index');
    expect(payload.hits.map((h) => h.name)).toEqual(['invoicing']);
    expect(payload.hits[0]?.matchedVia).toBe('name');
    expect(payload.hits[0]?.addRef).toBe('invoicing'); // default registry ⇒ bare
  });

  it('finds invoicing via substring fallback when no searchUrl is advertised (AC2)', async () => {
    writeCfg({ registries: { '@acme': INDEX_URL }, defaultRegistry: '@acme' });
    stubFetch({ [INDEX_URL]: INDEX_WITHOUT_SEARCH });
    await searchCommand('invoi', { json: true });
    const payload = JSON.parse(output()) as { source: string; hits: { name: string }[] };
    expect(payload.source).toBe('index');
    expect(payload.hits.map((h) => h.name)).toEqual(['invoicing']);
  });

  it('warns and falls back when the advertised search index 404s', async () => {
    writeCfg({ registries: { '@acme': INDEX_URL }, defaultRegistry: '@acme' });
    stubFetch({ [INDEX_URL]: INDEX_WITH_SEARCH, [SEARCH_URL]: { status: 404 } });
    await searchCommand('invoi', { json: true });
    expect(process.exitCode).toBeUndefined();
    const payload = JSON.parse(output()) as {
      source: string;
      warnings: string[];
      hits: { name: string }[];
    };
    expect(payload.source).toBe('index');
    expect(payload.warnings.join(' ')).toMatch(/search index unusable/);
    expect(payload.hits.map((h) => h.name)).toEqual(['invoicing']);
  });

  it('tolerates a bare-array search index (lenient shape)', async () => {
    writeCfg({ registries: { '@acme': INDEX_URL }, defaultRegistry: '@acme' });
    stubFetch({ [INDEX_URL]: INDEX_WITH_SEARCH, [SEARCH_URL]: SEARCH_INDEX.documents });
    await searchCommand('stripe', { json: true });
    const payload = JSON.parse(output()) as {
      source: string;
      hits: { name: string; matchedVia: string }[];
    };
    expect(payload.source).toBe('search-index');
    expect(payload.hits).toEqual([
      expect.objectContaining({ name: 'invoicing', matchedVia: 'description' }),
    ]);
  });

  it('no matches is a friendly message and exit 0', async () => {
    writeCfg({ registries: { '@acme': INDEX_URL }, defaultRegistry: '@acme' });
    stubFetch({ [INDEX_URL]: INDEX_WITH_SEARCH, [SEARCH_URL]: SEARCH_INDEX });
    await searchCommand('zeppelin', {});
    expect(process.exitCode).toBeUndefined();
    expect(output()).toMatch(/No blocks matching zeppelin/);
  });

  it('namespaces the add hint when the searched registry is not the default', async () => {
    // Default stays @ion (unreachable in the stub — never touched: --registry
    // fetches only @acme).
    writeCfg({ registries: { '@acme': INDEX_URL } });
    stubFetch({ [INDEX_URL]: INDEX_WITH_SEARCH, [SEARCH_URL]: SEARCH_INDEX });
    await searchCommand('crm', { registry: '@acme', json: true });
    const payload = JSON.parse(output()) as { hits: { addRef: string }[] };
    expect(payload.hits[0]?.addRef).toBe('@acme/crm');
  });

  it('human output renders the table with the claimed-trust badge and add hint', async () => {
    writeCfg({ registries: { '@acme': INDEX_URL }, defaultRegistry: '@acme' });
    stubFetch({ [INDEX_URL]: INDEX_WITH_SEARCH, [SEARCH_URL]: SEARCH_INDEX });
    await searchCommand('invoi', {});
    const text = output();
    expect(text).toContain('invoicing');
    expect(text).toContain('official (claimed)');
    expect(text).toContain('ion-drive add invoicing');
    expect(text).toMatch(/via search index/);
  });

  it('fails with a named error for an unconfigured --registry', async () => {
    writeCfg({});
    stubFetch({});
    await searchCommand('crm', { registry: '@nope', json: true });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output())).toHaveProperty('error');
  });
});
