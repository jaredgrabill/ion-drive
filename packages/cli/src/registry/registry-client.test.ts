/**
 * Unit tests for the registry client: the pure manifest helpers
 * (`dependenciesOf` must accept only the manifest-v1 record form — the legacy
 * array would leak `Object.keys` indices as fake block names), registry
 * resolution (env expansion fail-fast, unknown namespaces), and the fetch
 * paths (cache interplay, `--no-cache` semantics, blockUrl/artifact
 * resolution, the raw-bytes `fetchArtifact` seam, URL permission guard) with
 * an injected `fetchImpl` — no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, type IonProjectConfig } from '../config.js';
import {
  type Manifest,
  RegistryError,
  dependenciesOf,
  dependencyRecordOf,
  fetchArtifact,
  fetchBlock,
  fetchIndex,
  resetRegistryCache,
  resolveRegistry,
  withParams,
} from './registry-client.js';

describe('dependenciesOf', () => {
  it('returns the keys of a record-form dependencies map', () => {
    const manifest = {
      name: 'catalog',
      dependencies: { invoicing: '^0.1.0', '@acme/billing': '*' },
    } as Manifest;
    expect(dependenciesOf(manifest)).toEqual(['invoicing', '@acme/billing']);
    expect(dependencyRecordOf(manifest)).toEqual({ invoicing: '^0.1.0', '@acme/billing': '*' });
  });

  it('returns [] when dependencies is absent', () => {
    expect(dependenciesOf({ name: 'crm' } as Manifest)).toEqual([]);
  });

  it('returns [] for the legacy array form (never array indices)', () => {
    const manifest = { name: 'invoicing', dependencies: ['crm'] } as unknown as Manifest;
    expect(dependenciesOf(manifest)).toEqual([]);
    expect(dependencyRecordOf(manifest)).toEqual({});
  });

  it('returns [] for non-object dependencies values', () => {
    expect(dependenciesOf({ name: 'x', dependencies: null } as unknown as Manifest)).toEqual([]);
    expect(dependenciesOf({ name: 'x', dependencies: 'crm' } as unknown as Manifest)).toEqual([]);
  });
});

describe('resolveRegistry', () => {
  const config: IonProjectConfig = {
    serverUrl: 'http://localhost:3000',
    blocks: [],
    registries: {
      '@acme': {
        url: 'https://acme.test/index.json',
        headers: { authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
        params: { token: '${ACME_REGISTRY_TOKEN}' },
      },
    },
  };

  it('expands ${VAR} placeholders at resolve time', () => {
    const reg = resolveRegistry('@acme', config, { ACME_REGISTRY_TOKEN: 's3cret' });
    expect(reg.headers).toEqual({ authorization: 'Bearer s3cret' });
    expect(reg.params).toEqual({ token: 's3cret' });
  });

  it('fails fast — before any network — naming the unset variable (AC2)', () => {
    expect(() => resolveRegistry('@acme', config, {})).toThrow(ConfigError);
    expect(() => resolveRegistry('@acme', config, {})).toThrow(/ACME_REGISTRY_TOKEN/);
  });

  it('rejects an unconfigured namespace with the config fix', () => {
    expect(() => resolveRegistry('@nope', config, {})).toThrow(
      /add @nope to registries in ion\.config\.json/,
    );
  });
});

describe('fetch paths (injected fetchImpl)', () => {
  const REG_URL = 'https://reg.test/registry/index.json';
  const index = {
    schemaVersion: 1,
    name: 'Fixture',
    generatedAt: '2026-07-08T00:00:00Z',
    blocks: { crm: { latest: '0.2.0', blockUrl: 'blocks/crm.json' } },
  };
  const blockDoc = {
    schemaVersion: 1,
    name: 'crm',
    latest: '0.2.0',
    versions: {
      '0.2.0': {
        artifactUrl: '../../crm/dist/0.2.0/block.json',
        digest: `sha256:${'a'.repeat(64)}`,
        dependencies: {},
        requires: {},
        status: 'active',
      },
    },
  };

  let cacheDir: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ion-client-'));
    cacheDir = join(root, 'registry-cache');
    resetRegistryCache();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const reg = { namespace: '@test', url: REG_URL, headers: { 'x-auth': 'tok' }, params: {} };

  function jsonFetch(routes: Record<string, unknown>) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = routes[url];
      if (body === undefined) return new Response('nope', { status: 404 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  }

  it('fetches + caches the index; the second call reads the cache', async () => {
    const fetchImpl = jsonFetch({ [REG_URL]: index });
    const first = await fetchIndex(reg, { fetchImpl, cacheDir });
    expect(first.name).toBe('Fixture');
    resetRegistryCache(); // drop the memo so the disk cache answers
    const second = await fetchIndex(reg, { fetchImpl, cacheDir });
    expect(second.name).toBe('Fixture');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('noCache skips reads but still writes (the next command benefits)', async () => {
    const fetchImpl = jsonFetch({ [REG_URL]: index });
    await fetchIndex(reg, { fetchImpl, cacheDir });
    resetRegistryCache();
    await fetchIndex(reg, { fetchImpl, cacheDir, noCache: true }); // ignores the cached copy
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resetRegistryCache();
    await fetchIndex(reg, { fetchImpl, cacheDir }); // written by the noCache call
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends the registry headers on metadata fetches', async () => {
    const fetchImpl = jsonFetch({ [REG_URL]: index });
    await fetchIndex(reg, { fetchImpl, cacheDir });
    expect(fetchImpl).toHaveBeenCalledWith(REG_URL, { headers: { 'x-auth': 'tok' } });
  });

  it('resolves blockUrl against the index URL and returns the block file URL', async () => {
    const blockUrl = 'https://reg.test/registry/blocks/crm.json';
    const fetchImpl = jsonFetch({ [REG_URL]: index, [blockUrl]: blockDoc });
    const { doc, url } = await fetchBlock(reg, 'crm', { fetchImpl, cacheDir });
    expect(url).toBe(blockUrl);
    expect(doc.latest).toBe('0.2.0');
  });

  it('errors helpfully for a block absent from the index', async () => {
    const fetchImpl = jsonFetch({ [REG_URL]: index });
    await expect(fetchBlock(reg, 'nope', { fetchImpl, cacheDir })).rejects.toThrow(
      /has no block "nope"/,
    );
  });

  it('fetchArtifact returns the exact raw bytes (the spec-04 seam)', async () => {
    const payload = '{"name":"crm","version":"0.2.0"}';
    const fetchImpl = vi.fn(
      async () => new Response(payload, { status: 200 }),
    ) as unknown as typeof fetch;
    const { bytes, url } = await fetchArtifact(
      'https://reg.test/crm/dist/0.2.0/block.json',
      { 'x-auth': 'tok' },
      { fetchImpl },
    );
    expect(new TextDecoder().decode(bytes)).toBe(payload);
    expect(url).toBe('https://reg.test/crm/dist/0.2.0/block.json');
  });

  it('refuses non-permitted URLs before fetching (http off-localhost, file:)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      fetchIndex({ ...reg, url: 'http://evil.test/index.json' }, { fetchImpl, cacheDir }),
    ).rejects.toThrow(RegistryError);
    await expect(fetchArtifact('file:///c:/x.json', {}, { fetchImpl })).rejects.toThrow(
      /Refusing to fetch/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('withParams appends registry params to a URL', () => {
    expect(withParams('https://reg.test/a.json', { token: 't v' })).toBe(
      'https://reg.test/a.json?token=t+v',
    );
    expect(withParams('https://reg.test/a.json?x=1', { token: 't' })).toBe(
      'https://reg.test/a.json?x=1&token=t',
    );
    expect(withParams('https://reg.test/a.json', {})).toBe('https://reg.test/a.json');
  });
});
