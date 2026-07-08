/**
 * CLI-level tests against **real** fixture registries served from
 * `node:http` on 127.0.0.1 (allowed by the http-localhost rule): two
 * protocol-v1 registries — `@main` (open) and `@acme` (requires an
 * Authorization bearer header AND a `token` query param) — exercising
 * `${ACME_REGISTRY_TOKEN}` expansion + fail-fast (AC2), the same-registry
 * rule closing the dependency-confusion vector over real HTTP (AC3), the
 * `fetchArtifact` raw-bytes contract (the spec-04 seam), and the on-disk
 * cache (sha256 filename, token never written).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, type IonProjectConfig } from '../config.js';
import { cacheFilePath } from './cache.js';
import {
  fetchArtifact,
  fetchBlock,
  fetchIndex,
  resetRegistryCache,
  resolveRegistry,
  withParams,
} from './registry-client.js';
import { type ResolverIO, resolvePlan } from './resolver.js';

const TOKEN = 'acme-registry-token-1234567890abcdef';

/** Exact artifact bytes — byte-compared below (trailing newline intentional). */
const ARTIFACT_BYTES = Buffer.from(
  `${JSON.stringify({ name: 'billing', version: '1.2.0', objects: [] }, null, 2)}\n`,
  'utf8',
);

const indexDoc = (name: string, blocks: Record<string, { latest: string }>) => ({
  schemaVersion: 1,
  name,
  generatedAt: '2026-07-08T00:00:00Z',
  blocks: Object.fromEntries(
    Object.entries(blocks).map(([n, b]) => [n, { latest: b.latest, blockUrl: `blocks/${n}.json` }]),
  ),
});

const versionEntry = (name: string, version: string, deps: Record<string, string> = {}) => ({
  artifactUrl: `../../${name}/dist/${version}/block.json`,
  digest: `sha256:${'0'.repeat(64)}`,
  size: 1,
  publishedAt: '2026-07-08T00:00:00Z',
  dependencies: deps,
  requires: {},
  status: 'active',
});

interface Fixture {
  server: Server;
  url: string; // index URL
  requests: string[];
}

function startFixture(
  routes: Record<string, Buffer | object>,
  opts: { requireToken?: boolean } = {},
): Promise<Fixture> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(parsed.pathname);
    if (opts.requireToken) {
      const authed =
        req.headers.authorization === `Bearer ${TOKEN}` &&
        parsed.searchParams.get('token') === TOKEN;
      if (!authed) {
        res.writeHead(401).end('unauthorized');
        return;
      }
    }
    const body = routes[parsed.pathname];
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}/registry/index.json`, requests });
    });
  });
}

let main: Fixture;
let acme: Fixture;
let cacheDir: string;
let root: string;
let config: IonProjectConfig;
const env = { ACME_REGISTRY_TOKEN: TOKEN };

beforeAll(async () => {
  // @main: serves crm — and a decoy "shared" the confusion test must NOT pick.
  main = await startFixture({
    '/registry/index.json': indexDoc('Main Fixture', {
      crm: { latest: '0.2.0' },
      shared: { latest: '9.9.9' },
    }),
    '/registry/blocks/crm.json': {
      schemaVersion: 1,
      name: 'crm',
      latest: '0.2.0',
      versions: { '0.2.0': versionEntry('crm', '0.2.0') },
    },
    '/registry/blocks/shared.json': {
      schemaVersion: 1,
      name: 'shared',
      latest: '9.9.9',
      versions: { '9.9.9': versionEntry('shared', '9.9.9') },
    },
  });
  // @acme (auth-gated): billing depends on bare "shared" — must resolve HERE.
  acme = await startFixture(
    {
      '/registry/index.json': indexDoc('Acme Fixture', {
        billing: { latest: '1.2.0' },
        shared: { latest: '1.1.0' },
      }),
      '/registry/blocks/billing.json': {
        schemaVersion: 1,
        name: 'billing',
        latest: '1.2.0',
        versions: { '1.2.0': versionEntry('billing', '1.2.0', { shared: '^1.0.0' }) },
      },
      '/registry/blocks/shared.json': {
        schemaVersion: 1,
        name: 'shared',
        latest: '1.1.0',
        versions: { '1.1.0': versionEntry('shared', '1.1.0') },
      },
      '/billing/dist/1.2.0/block.json': ARTIFACT_BYTES,
    },
    { requireToken: true },
  );
});

afterAll(() => {
  main.server.close();
  acme.server.close();
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-fixture-'));
  cacheDir = join(root, 'registry-cache');
  resetRegistryCache();
  config = {
    serverUrl: 'http://localhost:3000',
    blocks: [],
    registries: {
      '@main': main.url,
      '@acme': {
        url: acme.url,
        headers: { authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
        params: { token: '${ACME_REGISTRY_TOKEN}' },
      },
    },
    defaultRegistry: '@main',
  };
});

function io(): ResolverIO {
  return {
    fetchIndex: (reg) => fetchIndex(reg, { cacheDir }),
    fetchBlock: (reg, name) => fetchBlock(reg, name, { cacheDir }),
    getLocalOrUrlManifest: async () => {
      throw new Error('not used');
    },
  };
}

describe('private registry auth (AC2)', () => {
  it('expands ${ACME_REGISTRY_TOKEN} into headers and params and fetches', async () => {
    const reg = resolveRegistry('@acme', config, env);
    const index = await fetchIndex(reg, { cacheDir, noCache: true });
    expect(index.name).toBe('Acme Fixture');
  });

  it('fails fast with the named variable before any network call', async () => {
    const before = acme.requests.length;
    expect(() => resolveRegistry('@acme', config, {})).toThrow(ConfigError);
    expect(() => resolveRegistry('@acme', config, {})).toThrow(/ACME_REGISTRY_TOKEN/);
    expect(acme.requests.length).toBe(before); // nothing hit the wire
  });

  it('never writes the token into the cache file', async () => {
    const reg = resolveRegistry('@acme', config, env);
    await fetchIndex(reg, { cacheDir, noCache: true });
    await fetchBlock(reg, 'billing', { cacheDir, noCache: true });
    const file = cacheFilePath(acme.url, cacheDir);
    expect(existsSync(file)).toBe(true); // sha256(<indexUrl>).json
    const bytes = readFileSync(file, 'utf8');
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).toContain('billing'); // the doc itself IS cached
  });
});

describe('cross-registry resolution over real HTTP (AC3)', () => {
  it("resolves @acme/billing's bare dep in @acme, never @main's decoy", async () => {
    const plan = await resolvePlan(
      { kind: 'registry', namespace: '@acme', name: 'billing', selector: '^1.2' },
      {
        config,
        installed: new Map(),
        recordedBlocks: [],
        io: io(),
        env,
      },
    );
    expect(plan.items.map((i) => i.name)).toEqual(['shared', 'billing']);
    const shared = plan.items.find((i) => i.name === 'shared');
    expect(shared?.version).toBe('1.1.0'); // @acme's — not @main's 9.9.9
    expect(shared?.sourceUrl).toContain(new URL(acme.url).host);
  });
});

describe('fetchArtifact (the spec-04 seam)', () => {
  it('returns bytes identical to the served file, with params appended', async () => {
    const reg = resolveRegistry('@acme', config, env);
    const artifactUrl = new URL('/billing/dist/1.2.0/block.json', acme.url).toString();
    const { bytes, url } = await fetchArtifact(withParams(artifactUrl, reg.params), reg.headers);
    expect(Buffer.from(bytes).equals(ARTIFACT_BYTES)).toBe(true);
    expect(url).toContain(`token=${TOKEN}`); // the query-token pattern reached the wire
  });
});
