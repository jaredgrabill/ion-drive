/**
 * Unit tests for the `ion-drive registry` command group (spec-03 §5 / AC6 +
 * spec-08 §3 / AC3): list/add/remove/ping incl. `--json`, the add-time
 * legacy-index rejection, the no-URL directory lookup (happy path, unknown
 * namespace hint, unreachable directory, declined confirm), URL permission
 * refusal, and the remove guard (installed blocks from the registry block
 * removal unless --force).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import prompts from 'prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IonProjectConfig, resetConfigWarnings } from '../config.js';
import { resetRegistryCache } from '../registry/registry-client.js';
import {
  registryAddCommand,
  registryListCommand,
  registryPingCommand,
  registryRemoveCommand,
} from './registry.js';

const INDEX = {
  schemaVersion: 1,
  name: 'Fixture Registry',
  generatedAt: '2026-07-08T00:00:00Z',
  blocks: { crm: { latest: '0.2.0', blockUrl: 'blocks/crm.json' } },
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

function readCfg(): IonProjectConfig {
  return JSON.parse(readFileSync(join(dir, 'ion.config.json'), 'utf8')) as IonProjectConfig;
}

/** Everything printed, ANSI-stripped and joined. */
function output(): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return logged.join('\n').replace(/\[[0-9;]*m/g, '');
}

/**
 * Stubs global fetch with fixed routes. Anything un-routed — including the
 * built-in @ion registry URL — throws like an unreachable host, so these
 * tests never depend on the real registry.iondrive.dev (up OR down) and never
 * touch the network.
 */
function stubFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = routes[url];
      if (body === undefined) throw new TypeError(`fetch failed (unstubbed: ${url})`);
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-registry-cmd-'));
  cwd = process.cwd();
  process.chdir(dir);
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Isolate the disk cache from the developer's real ~/.ion-drive.
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

describe('registry add', () => {
  it('validates the index then writes the config (with --json output)', async () => {
    writeCfg({});
    stubFetch({ 'http://localhost:9700/index.json': INDEX });
    await registryAddCommand('@acme', 'http://localhost:9700/index.json', { json: true });
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(output())).toEqual({
      namespace: '@acme',
      url: 'http://localhost:9700/index.json',
      name: 'Fixture Registry',
      blocks: 1,
    });
    expect(readCfg().registries).toEqual({ '@acme': 'http://localhost:9700/index.json' });
  });

  it('rejects a legacy (unversioned) index without touching the config (AC6)', async () => {
    writeCfg({});
    stubFetch({ 'http://localhost:9700/index.json': { blocks: {} } }); // no schemaVersion
    await registryAddCommand('@acme', 'http://localhost:9700/index.json', {});
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('pre-release unversioned format');
    expect(readCfg().registries).toBeUndefined();
  });

  it('rejects a non-localhost http URL before fetching', async () => {
    writeCfg({});
    stubFetch({});
    await registryAddCommand('@acme', 'http://evil.test/index.json', {});
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('must be https');
  });

  it('rejects a bad namespace with the grammar', async () => {
    await registryAddCommand('acme', 'https://a.test/index.json', {});
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('"@acme"');
  });

  // --- The no-URL directory-lookup form (spec-08 §3 / AC3) -------------------

  const MAIN_URL = 'https://registry.iondrive.dev/registry/index.json';
  const MAIN_INDEX = {
    schemaVersion: 1,
    name: 'Ion Drive Official Blocks',
    generatedAt: '2026-07-09T00:00:00Z',
    registriesUrl: '../registries.json',
    blocks: {},
  };
  const DIRECTORY = {
    schemaVersion: 1,
    registries: [
      {
        namespace: '@acme',
        url: 'http://localhost:9700/index.json',
        owner: 'Acme Corp',
        description: 'Acme blocks.',
        trust: 'listed',
      },
    ],
  };

  it('bare add resolves through the directory, probes the target, and writes config (AC3)', async () => {
    writeCfg({});
    stubFetch({
      [MAIN_URL]: MAIN_INDEX,
      'https://registry.iondrive.dev/registries.json': DIRECTORY,
      'http://localhost:9700/index.json': INDEX,
    });
    await registryAddCommand('@acme', undefined, { json: true });
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(output())).toEqual({
      namespace: '@acme',
      url: 'http://localhost:9700/index.json',
      name: 'Fixture Registry',
      blocks: 1,
      fromDirectory: true,
      owner: 'Acme Corp',
      trust: 'listed',
    });
    expect(readCfg().registries).toEqual({ '@acme': 'http://localhost:9700/index.json' });
  });

  it('bare add falls back to the sibling registries.json when the index has no registriesUrl', async () => {
    writeCfg({});
    stubFetch({
      [MAIN_URL]: { ...MAIN_INDEX, registriesUrl: undefined },
      'https://registry.iondrive.dev/registry/registries.json': DIRECTORY,
      'http://localhost:9700/index.json': INDEX,
    });
    await registryAddCommand('@acme', undefined, { json: true });
    expect(process.exitCode).toBeUndefined();
    expect(readCfg().registries).toEqual({ '@acme': 'http://localhost:9700/index.json' });
  });

  it('an unknown namespace produces the documented pass-the-URL hint (AC3)', async () => {
    writeCfg({});
    stubFetch({
      [MAIN_URL]: MAIN_INDEX,
      'https://registry.iondrive.dev/registries.json': DIRECTORY,
    });
    await registryAddCommand('@nope', undefined, {});
    expect(process.exitCode).toBe(1);
    expect(output()).toContain(
      '@nope is not in the registries directory — pass the URL explicitly: ion-drive registry add @nope <url>',
    );
    expect(readCfg().registries).toBeUndefined();
  });

  it('an unreachable directory is a named error and nothing is written', async () => {
    writeCfg({});
    stubFetch({ [MAIN_URL]: MAIN_INDEX }); // registries.json un-routed
    await registryAddCommand('@acme', undefined, { json: true });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output())).toHaveProperty('error');
    expect(readCfg().registries).toBeUndefined();
  });

  it('a malformed directory is a named error and nothing is written', async () => {
    writeCfg({});
    stubFetch({
      [MAIN_URL]: MAIN_INDEX,
      'https://registry.iondrive.dev/registries.json': { registries: [] }, // no schemaVersion
    });
    await registryAddCommand('@acme', undefined, {});
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('missing schemaVersion');
    expect(readCfg().registries).toBeUndefined();
  });

  it('declining the confirmation writes nothing', async () => {
    writeCfg({});
    stubFetch({
      [MAIN_URL]: MAIN_INDEX,
      'https://registry.iondrive.dev/registries.json': DIRECTORY,
      'http://localhost:9700/index.json': INDEX,
    });
    prompts.inject([false]);
    await registryAddCommand('@acme', undefined, {});
    expect(output()).toContain('nothing written');
    expect(readCfg().registries).toBeUndefined();
  });
});

describe('registry list', () => {
  it('lists built-in and configured registries with block counts (--json)', async () => {
    writeCfg({ registries: { '@acme': 'http://localhost:9700/index.json' } });
    stubFetch({ 'http://localhost:9700/index.json': INDEX });
    await registryListCommand({ json: true, cache: false });
    const rows = JSON.parse(output()) as {
      namespace: string;
      blocks?: number;
      error?: string;
      isDefault: boolean;
    }[];
    const acme = rows.find((r) => r.namespace === '@acme');
    expect(acme?.blocks).toBe(1);
    const ion = rows.find((r) => r.namespace === '@ion');
    expect(ion?.isDefault).toBe(true);
    expect(ion?.error).toBeDefined(); // @ion is un-routed in the stub ⇒ deterministic error row
    expect(process.exitCode).toBe(1); // an unreachable registry marks the run
  });
});

describe('registry remove', () => {
  it('removes a configured registry', async () => {
    writeCfg({ registries: { '@acme': 'http://localhost:9700/index.json' } });
    await registryRemoveCommand('@acme', { json: true });
    expect(JSON.parse(output())).toMatchObject({ namespace: '@acme', removed: true });
    expect(readCfg().registries).toEqual({});
  });

  it('refuses while installed blocks came from it, naming them; --force overrides', async () => {
    writeCfg({
      registries: { '@acme': 'http://localhost:9700/index.json' },
      blocks: [
        {
          name: 'billing',
          version: '1.0.0',
          digest: null,
          source: '@acme',
          installedAt: '2026-07-08T00:00:00Z',
        },
      ],
    });
    await registryRemoveCommand('@acme', {});
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('billing');
    expect(readCfg().registries).toEqual({ '@acme': 'http://localhost:9700/index.json' });

    process.exitCode = undefined;
    logged = [];
    await registryRemoveCommand('@acme', { force: true });
    expect(process.exitCode).toBeUndefined();
    expect(readCfg().registries).toEqual({});
  });

  it('cannot remove the built-in @ion, but removing an override reverts it', async () => {
    writeCfg({});
    await registryRemoveCommand('@ion', {});
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('built in');

    process.exitCode = undefined;
    logged = [];
    writeCfg({ registries: { '@ion': 'http://localhost:9700/index.json' } });
    await registryRemoveCommand('@ion', { json: true });
    expect(JSON.parse(output())).toMatchObject({ removed: true, revertedToBuiltIn: true });
  });

  it('errors for an unconfigured namespace', async () => {
    writeCfg({});
    await registryRemoveCommand('@nope', {});
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('not configured');
  });
});

describe('registry ping', () => {
  it('reports name/generatedAt/blocks/latency (--json), bypassing the cache', async () => {
    writeCfg({ registries: { '@acme': 'http://localhost:9700/index.json' } });
    stubFetch({ 'http://localhost:9700/index.json': INDEX });
    await registryPingCommand('@acme', { json: true });
    const payload = JSON.parse(output()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      namespace: '@acme',
      name: 'Fixture Registry',
      generatedAt: '2026-07-08T00:00:00Z',
      blocks: 1,
    });
    expect(typeof payload.latencyMs).toBe('number');
  });

  it('fails with the unreachable error in --json mode', async () => {
    writeCfg({ registries: { '@acme': 'http://localhost:9700/index.json' } });
    stubFetch({});
    await registryPingCommand('@acme', { json: true });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output())).toHaveProperty('error');
  });
});
