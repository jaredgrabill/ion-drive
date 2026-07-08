/**
 * Unit tests for the spec-03 resolver: same-registry rule, cross-registry
 * collision, range collection + highest-satisfying selection, yanked /
 * deprecated status rules, installed pruning + conflicts (with the `update`
 * fix and `--force`), topo order + cycles, Levenshtein suggestions, and
 * `requires.core` warnings — all over injected fake fetchers, no network.
 */

import { describe, expect, it } from 'vitest';
import { BUILT_IN_REGISTRIES, type IonProjectConfig } from '../config.js';
import type { RegistryBlockDoc, RegistryVersionEntry } from './protocol.js';
import type { ParsedRef } from './ref.js';
import type { Manifest, ResolvedRegistry } from './registry-client.js';
import { ResolveError, type ResolverIO, resolvePlan } from './resolver.js';

// --- Fixture plumbing --------------------------------------------------------

const MAIN_URL = 'https://main.test/registry/index.json';
const ACME_URL = 'https://acme.test/registry/index.json';

interface VersionSpec {
  deps?: Record<string, string>;
  status?: 'active' | 'deprecated' | 'yanked';
  statusReason?: string;
  requiresCore?: string;
  size?: number;
  attestationUrl?: string;
  publishedAt?: string;
}

/** Builds a protocol-v1 block doc from a terse version spec. */
function doc(
  name: string,
  versions: Record<string, VersionSpec>,
  latest?: string,
  repository?: string,
): RegistryBlockDoc {
  const entries: Record<string, RegistryVersionEntry> = {};
  for (const [version, spec] of Object.entries(versions)) {
    entries[version] = {
      artifactUrl: `../../${name}/dist/${version}/block.json`,
      digest: `sha256:${'0'.repeat(64)}`,
      size: spec.size,
      attestationUrl: spec.attestationUrl,
      publishedAt: spec.publishedAt,
      dependencies: spec.deps ?? {},
      requires: spec.requiresCore ? { core: spec.requiresCore } : {},
      status: spec.status ?? 'active',
      statusReason: spec.statusReason,
      yankedAt: spec.status === 'yanked' ? '2026-07-08T00:00:00Z' : undefined,
    };
  }
  const sorted = Object.keys(versions).sort();
  const latestKey = latest ?? sorted[sorted.length - 1] ?? '0.0.0';
  return {
    schemaVersion: 1,
    name,
    repository,
    latest: latestKey,
    versions: entries,
    advisories: [],
  };
}

type FakeRegistry = Record<string, RegistryBlockDoc>;

/** Injected IO over in-memory registries keyed by index URL. */
function fakeIO(registries: Record<string, FakeRegistry>): ResolverIO {
  return {
    fetchIndex: async (reg: ResolvedRegistry) => {
      const blocks = registries[reg.url];
      if (!blocks) throw new Error(`no fixture registry at ${reg.url}`);
      return {
        blocks: Object.fromEntries(
          Object.keys(blocks).map((name) => [
            name,
            { latest: '', blockUrl: `blocks/${name}.json` },
          ]),
        ),
      };
    },
    fetchBlock: async (reg: ResolvedRegistry, name: string) => {
      const block = registries[reg.url]?.[name];
      if (!block) throw new Error(`no fixture block ${name} at ${reg.url}`);
      return { doc: block, url: new URL(`blocks/${name}.json`, reg.url).toString() };
    },
    getLocalOrUrlManifest: async () => {
      throw new Error('not a manifest-root test');
    },
  };
}

function config(overrides: Partial<IonProjectConfig> = {}): IonProjectConfig {
  return { serverUrl: 'http://localhost:3000', blocks: [], ...overrides };
}

/** A config whose default registry is the fixture @main. */
function mainConfig(overrides: Partial<IonProjectConfig> = {}): IonProjectConfig {
  return config({
    registries: { '@main': MAIN_URL, '@acme': ACME_URL },
    defaultRegistry: '@main',
    ...overrides,
  });
}

function registryRef(name: string, selector?: string, namespace?: string): ParsedRef {
  return { kind: 'registry', name, namespace, selector };
}

async function plan(
  ref: ParsedRef,
  registries: Record<string, FakeRegistry>,
  opts: {
    cfg?: IonProjectConfig;
    installed?: Record<string, string>;
    recorded?: { name: string; version: string }[];
    serverCoreVersion?: string;
    force?: boolean;
    io?: ResolverIO;
  } = {},
) {
  return resolvePlan(ref, {
    config: opts.cfg ?? mainConfig(),
    installed: new Map(Object.entries(opts.installed ?? {})),
    recordedBlocks: (opts.recorded ?? []).map((r) => ({
      ...r,
      digest: null,
      source: '@main',
      installedAt: '2026-07-08T00:00:00Z',
    })),
    serverCoreVersion: opts.serverCoreVersion,
    force: opts.force,
    io: opts.io ?? fakeIO(registries),
    env: {},
  });
}

const names = (p: { items: { name: string }[] }) => p.items.map((i) => i.name);

// --- Basics -------------------------------------------------------------------

describe('resolvePlan basics', () => {
  it('resolves a bare ref in the built-in @ion default registry (AC1)', async () => {
    const registries = {
      [BUILT_IN_REGISTRIES['@ion'] as string]: { crm: doc('crm', { '0.2.0': {} }) },
    };
    const p = await plan(registryRef('crm'), registries, { cfg: config() });
    expect(names(p)).toEqual(['crm']);
    expect(p.items[0]?.source).toBe('@ion');
    expect(p.items[0]?.version).toBe('0.2.0');
  });

  it('honors the ION_DRIVE_REGISTRY env override on the default registry (AC1)', async () => {
    const registries = { [MAIN_URL]: { crm: doc('crm', { '0.2.0': {} }) } };
    const p = await resolvePlan(registryRef('crm'), {
      config: config(),
      installed: new Map(),
      recordedBlocks: [],
      io: fakeIO(registries),
      env: { ION_DRIVE_REGISTRY: MAIN_URL },
    });
    expect(p.items[0]?.source).toBe('@ion'); // still the default namespace…
    expect(p.items[0]?.sourceUrl).toContain('main.test'); // …but the overridden URL
  });

  it('resolves the artifact URL relative to the block file (spec-01 §2)', async () => {
    const registries = { [MAIN_URL]: { crm: doc('crm', { '0.2.0': {} }) } };
    const p = await plan(registryRef('crm'), registries);
    expect(p.items[0]?.sourceUrl).toBe('https://main.test/crm/dist/0.2.0/block.json');
  });

  it('threads digest/size/attestationUrl/repository/publishedAt onto plan items (spec-04)', async () => {
    const registries = {
      [MAIN_URL]: {
        crm: doc(
          'crm',
          {
            '0.2.0': {
              size: 1234,
              // Relative — must resolve against the block file URL, like artifactUrl.
              attestationUrl: '../../crm/dist/0.2.0/block.json.sigstore.json',
              publishedAt: '2026-07-01T00:00:00Z',
            },
          },
          undefined,
          'https://github.com/acme/blocks',
        ),
      },
    };
    const p = await plan(registryRef('crm'), registries);
    const item = p.items[0];
    expect(item?.digest).toBe(`sha256:${'0'.repeat(64)}`);
    expect(item?.size).toBe(1234);
    expect(item?.attestationUrl).toBe('https://main.test/crm/dist/0.2.0/block.json.sigstore.json');
    expect(item?.repository).toBe('https://github.com/acme/blocks');
    expect(item?.publishedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('with no selector picks the registry latest, not just the highest version', async () => {
    const registries = {
      [MAIN_URL]: { crm: doc('crm', { '0.1.0': {}, '0.2.0': {}, '0.3.0': {} }, '0.2.0') },
    };
    const p = await plan(registryRef('crm'), registries);
    expect(p.items[0]?.version).toBe('0.2.0');
  });

  it('a selector range picks the highest satisfying version', async () => {
    const registries = {
      [MAIN_URL]: { crm: doc('crm', { '0.1.0': {}, '0.2.0': {}, '0.2.5': {}, '0.3.0': {} }) },
    };
    const p = await plan(registryRef('crm', '^0.2.0'), registries);
    expect(p.items[0]?.version).toBe('0.2.5');
  });

  it('orders dependencies before dependents and tags them', async () => {
    const registries = {
      [MAIN_URL]: {
        crm: doc('crm', { '0.2.0': {} }),
        invoicing: doc('invoicing', { '0.1.0': { deps: { crm: '^0.2.0' } } }),
      },
    };
    const p = await plan(registryRef('invoicing'), registries);
    expect(names(p)).toEqual(['crm', 'invoicing']);
    expect(p.items[0]?.isDependency).toBe(true);
    expect(p.items[1]?.isDependency).toBe(false);
  });

  it('fails fast on dependency cycles', async () => {
    const registries = {
      [MAIN_URL]: {
        loop_a: doc('loop_a', { '1.0.0': { deps: { loop_b: '*' } } }),
        loop_b: doc('loop_b', { '1.0.0': { deps: { loop_a: '*' } } }),
      },
    };
    await expect(plan(registryRef('loop_a'), registries)).rejects.toThrow(/Circular dependency/);
  });

  it('suggests a close name for an unknown block', async () => {
    const registries = { [MAIN_URL]: { crm: doc('crm', { '0.2.0': {} }) } };
    await expect(plan(registryRef('crn'), registries)).rejects.toThrow(/Did you mean `crm`\?/);
  });

  it('errors with "add @ns to registries" for an unconfigured namespace', async () => {
    await expect(plan(registryRef('billing', undefined, '@nope'), {})).rejects.toThrow(
      /add @nope to registries in ion\.config\.json/,
    );
  });
});

// --- Same-registry rule + collisions (AC3) --------------------------------------

describe('same-registry rule', () => {
  it('resolves a bare dep in the depending block registry, never the default', async () => {
    const registries = {
      // The confusion vector: @main also has a "billing-core" — must NOT win.
      [MAIN_URL]: { 'billing-core': doc('billing-core', { '9.9.9': {} }) },
      [ACME_URL]: {
        billing: doc('billing', { '1.0.0': { deps: { 'billing-core': '^1.0.0' } } }),
        'billing-core': doc('billing-core', { '1.2.0': {} }),
      },
    };
    const p = await plan(registryRef('billing', undefined, '@acme'), registries);
    const dep = p.items.find((i) => i.name === 'billing-core');
    expect(dep?.registry).toBe('@acme');
    expect(dep?.version).toBe('1.2.0');
    expect(dep?.sourceUrl).toContain('acme.test');
  });

  it('errors when a bare dep is missing from the depending block registry', async () => {
    const registries = {
      [MAIN_URL]: { 'billing-core': doc('billing-core', { '1.0.0': {} }) },
      [ACME_URL]: {
        billing: doc('billing', { '1.0.0': { deps: { 'billing-core': '^1.0.0' } } }),
      },
    };
    const err = await plan(registryRef('billing', undefined, '@acme'), registries).catch((e) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.message).toContain('"billing" depends on "billing-core"');
    expect(err.message).toContain('@acme');
    expect(err.message).toContain('ask the block author to publish');
  });

  it('hard-errors when two registries supply the same bare name in one plan', async () => {
    const registries = {
      [MAIN_URL]: {
        app: doc('app', { '1.0.0': { deps: { shared: '*', '@acme/shared': '*' } } }),
        shared: doc('shared', { '1.0.0': {} }),
      },
      [ACME_URL]: { shared: doc('shared', { '1.0.0': {} }) },
    };
    await expect(plan(registryRef('app'), registries)).rejects.toThrow(/name collision/i);
  });

  it('namespaced deps resolve in their named registry', async () => {
    const registries = {
      [MAIN_URL]: { app: doc('app', { '1.0.0': { deps: { '@acme/widgets': '^2.0.0' } } }) },
      [ACME_URL]: { widgets: doc('widgets', { '2.1.0': {} }) },
    };
    const p = await plan(registryRef('app'), registries);
    expect(p.items.find((i) => i.name === 'widgets')?.registry).toBe('@acme');
  });
});

// --- Range conflicts + installed pruning (AC4) -----------------------------------

describe('ranges and installed versions', () => {
  const registries = {
    [MAIN_URL]: {
      crm: doc('crm', { '0.1.0': {}, '0.2.0': {}, '0.3.0': {} }),
      invoicing: doc('invoicing', { '0.1.0': { deps: { crm: '^0.2.0' } } }),
    },
  };

  it('lists every constraint with requiredBy (including "you") on conflict', async () => {
    const conflicting = {
      [MAIN_URL]: {
        crm: doc('crm', { '0.1.0': {}, '0.2.0': {} }),
        a: doc('a', { '1.0.0': { deps: { crm: '^0.1.0' } } }),
        b: doc('b', { '1.0.0': { deps: { a: '*', crm: '^0.2.0' } } }),
      },
    };
    const err = await plan(registryRef('b'), conflicting).catch((e) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.message).toContain('No version of "crm" satisfies all constraints');
    expect(err.message).toContain('^0.1.0 (required by a)');
    expect(err.message).toContain('^0.2.0 (required by b)');
  });

  it('includes the CLI selector as a "you" constraint', async () => {
    const err = await plan(registryRef('crm', '9.9.9'), registries).catch((e) => e);
    expect(err.message).toContain('9.9.9 (required by you)');
  });

  it('prunes an installed dependency that satisfies every range', async () => {
    const p = await plan(registryRef('invoicing'), registries, { installed: { crm: '0.2.0' } });
    expect(names(p)).toEqual(['invoicing']);
    expect(p.satisfied).toEqual(['crm']);
  });

  it('errors with the update fix when installed violates a dep range', async () => {
    const err = await plan(registryRef('invoicing'), registries, {
      installed: { crm: '0.1.0' },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.message).toBe(
      'crm 0.1.0 is installed but invoicing needs ^0.2.0 — run `ion-drive update crm`',
    );
  });

  it('--force downgrades the installed conflict to a warning and proceeds', async () => {
    const p = await plan(registryRef('invoicing'), registries, {
      installed: { crm: '0.1.0' },
      force: true,
    });
    expect(names(p)).toEqual(['crm', 'invoicing']);
    expect(p.warnings.some((w) => w.includes('--force'))).toBe(true);
  });

  it('an installed root prunes to "nothing to do" without --force', async () => {
    const p = await plan(registryRef('crm'), registries, { installed: { crm: '0.3.0' } });
    expect(p.items).toEqual([]);
    expect(p.satisfied).toEqual(['crm']);
  });

  it('--force keeps an installed root in the plan (reinstall)', async () => {
    const p = await plan(registryRef('crm'), registries, {
      installed: { crm: '0.3.0' },
      force: true,
    });
    expect(names(p)).toEqual(['crm']);
  });
});

// --- Status rules (AC5) -----------------------------------------------------------

describe('version status rules', () => {
  it('never auto-selects a yanked version (even when it is latest)', async () => {
    const registries = {
      [MAIN_URL]: { crm: doc('crm', { '0.2.0': {}, '0.3.0': { status: 'yanked' } }, '0.3.0') },
    };
    const p = await plan(registryRef('crm'), registries);
    expect(p.items[0]?.version).toBe('0.2.0');
  });

  it('allows an exact re-install of a recorded yanked version, loudly', async () => {
    const registries = {
      [MAIN_URL]: { crm: doc('crm', { '0.2.0': {}, '0.3.0': { status: 'yanked' } }, '0.2.0') },
    };
    const p = await plan(registryRef('crm', '0.3.0'), registries, {
      recorded: [{ name: 'crm', version: '0.3.0' }],
    });
    expect(p.items[0]?.version).toBe('0.3.0');
    expect(p.items[0]?.warnings.some((w) => w.includes('YANKED'))).toBe(true);
  });

  it('refuses an exact yanked version that is NOT recorded locally', async () => {
    const registries = {
      [MAIN_URL]: { crm: doc('crm', { '0.2.0': {}, '0.3.0': { status: 'yanked' } }, '0.2.0') },
    };
    await expect(plan(registryRef('crm', '0.3.0'), registries)).rejects.toThrow(
      /No version of "crm" satisfies/,
    );
  });

  it('deprecated versions install with a warning', async () => {
    const registries = {
      [MAIN_URL]: {
        crm: doc('crm', { '0.2.0': { status: 'deprecated', statusReason: 'use 0.3' } }, '0.2.0'),
      },
    };
    const p = await plan(registryRef('crm', '0.2.0'), registries);
    expect(p.items[0]?.warnings[0]).toContain('deprecated');
    expect(p.items[0]?.warnings[0]).toContain('use 0.3');
  });
});

// --- requires.core + manifest roots -------------------------------------------------

describe('requires.core and local/URL roots', () => {
  it('warns (never fails) when requires.core does not match the server', async () => {
    const registries = {
      [MAIN_URL]: { crm: doc('crm', { '0.2.0': { requiresCore: '>=0.9.0' } }) },
    };
    const p = await plan(registryRef('crm'), registries, { serverCoreVersion: '0.3.0' });
    expect(p.warnings.some((w) => w.includes('requires core >=0.9.0'))).toBe(true);
    expect(names(p)).toEqual(['crm']);
  });

  it("resolves a local root's bare deps in the consumer default registry (C5)", async () => {
    const registries = { [MAIN_URL]: { crm: doc('crm', { '0.2.0': {} }) } };
    const manifest: Manifest = {
      name: 'my_block',
      version: '1.0.0',
      dependencies: { crm: '^0.2.0' },
      objects: [{ name: 'widgets' }],
    };
    const io: ResolverIO = {
      ...fakeIO(registries),
      getLocalOrUrlManifest: async () => ({ manifest, digest: `sha256:${'b'.repeat(64)}` }),
    };
    const p = await plan({ kind: 'local', path: './my-block' }, registries, { io });
    expect(names(p)).toEqual(['crm', 'my_block']);
    const root = p.items.find((i) => i.name === 'my_block');
    expect(root?.source).toBe('local');
    expect(root?.manifest).toBe(manifest);
    // The digest computed at planning time rides on the item (spec-04 C8).
    expect(root?.digest).toBe(`sha256:${'b'.repeat(64)}`);
    expect(p.items.find((i) => i.name === 'crm')?.registry).toBe('@main');
  });

  it('keeps the direct URL as a URL root source', async () => {
    const manifest: Manifest = { name: 'solo', version: '2.0.0' };
    const io: ResolverIO = {
      ...fakeIO({}),
      getLocalOrUrlManifest: async () => ({ manifest, digest: `sha256:${'c'.repeat(64)}` }),
    };
    const p = await plan({ kind: 'url', url: 'https://x.test/block.json' }, {}, { io });
    expect(p.items[0]?.source).toBe('https://x.test/block.json');
    expect(p.items[0]?.sourceUrl).toBe('https://x.test/block.json');
    expect(p.items[0]?.digest).toBe(`sha256:${'c'.repeat(64)}`);
  });
});
