/**
 * Unit tests for the registry generator (spec-05 §1 / AC1+AC2+AC6): in-memory
 * BuildFs + fixed clock + the REAL core validator (workspace devDep — the
 * same strict parsers the shipped command loads), covering discovery,
 * pack-if-missing byte identity, append-only enforcement (tampered artifacts,
 * mutated entries, deleted dist), `--check` drift detection, `latest`
 * computation, the D5 attestationUrl exception, `--block` limiting, and the
 * `applyStatusEdit` yank/deprecate writer.
 */

import {
  parseManifest,
  parseRegistriesDirectory,
  parseRegistryBlock,
  parseRegistryIndex,
} from '@ion-drive/core';
import { describe, expect, it } from 'vitest';
import {
  type BuildFs,
  RegistryBuildError,
  applyStatusEdit,
  buildRegistry,
  computeLatest,
  discoverBlocks,
} from './build.js';
import { computeDigest, packBytes } from './verify.js';

const validator = {
  parseManifest,
  parseRegistryIndex,
  parseRegistryBlock,
  parseRegistriesDirectory,
};

const T1 = () => new Date('2026-07-08T10:00:00.000Z');
const T2 = () => new Date('2026-07-09T11:30:00.000Z');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A fully in-memory {@link BuildFs}; directories are implied by file paths. */
function createMemFs(initial: Record<string, string>): {
  fs: BuildFs;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  for (const [path, contents] of Object.entries(initial)) files.set(path, encoder.encode(contents));
  const isDir = (path: string) => {
    const prefix = `${path}/`;
    for (const key of files.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };
  const fs: BuildFs = {
    readdir: (dir) => {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const child = key.slice(prefix.length).split('/')[0];
          if (child) names.add(child);
        }
      }
      return [...names];
    },
    readFile: (path) => {
      const file = files.get(path);
      if (!file) throw new Error(`ENOENT: ${path}`);
      return file;
    },
    writeFile: (path, data) => {
      files.set(path, data);
    },
    exists: (path) => files.has(path) || isDir(path),
    stat: (path) => ({ isDirectory: !files.has(path) && isDir(path) }),
    mkdir: () => {},
  };
  return { fs, files };
}

function manifestJson(name: string, version: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name, version, title: name.toUpperCase(), ...extra }, null, 2)}\n`;
}

const CONFIG = `${JSON.stringify(
  {
    name: 'Test Registry',
    description: 'A fixture registry.',
    homepage: 'https://blocks.test',
    repository: 'https://github.com/acme/blocks',
    trust: 'official',
  },
  null,
  2,
)}\n`;

/** A repo with two blocks (one code-bearing) and non-block dirs to skip. */
function freshRepo() {
  return createMemFs({
    'repo/registry.config.json': CONFIG,
    'repo/crm/block.json': manifestJson('crm', '0.2.0', { dependencies: { audit: '^0.1.0' } }),
    'repo/crm/code/index.ts': 'export default 1;\n',
    'repo/crm/code/util/helpers.ts': 'export const x = 2;\n',
    'repo/audit/block.json': manifestJson('audit', '0.1.0'),
    'repo/docs/readme.md': 'not a block',
    'repo/schemas/registry-index.v1.json': '{}',
    'repo/.github/workflows/ci.yml': 'name: ci',
    'repo/registry.config.json.bak': 'ignored file',
  });
}

function readJson(files: Map<string, Uint8Array>, path: string): Record<string, unknown> {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`test: ${path} was not written`);
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

type Doc = { latest: string; versions: Record<string, Record<string, unknown>> };

describe('discoverBlocks', () => {
  it('finds */block.json one level deep, skipping registry/schemas/docs/dot-dirs', () => {
    const { fs } = freshRepo();
    fs.writeFile('repo/registry/blocks/old.json', encoder.encode('{}'));
    expect(discoverBlocks(fs, 'repo')).toEqual(['audit', 'crm']);
  });
});

describe('buildRegistry', () => {
  it('refuses without registry.config.json (named, actionable)', () => {
    const { fs } = createMemFs({ 'repo/crm/block.json': manifestJson('crm', '0.1.0') });
    const result = buildRegistry('repo', { fs, validator, now: T1 });
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatch(/registry\.config\.json is missing/);
    expect(result.wrote).toEqual([]);
  });

  it('a validate failure aborts the whole build with nothing written', () => {
    const { fs, files } = freshRepo();
    files.set('repo/crm/block.json', encoder.encode(manifestJson('crm', 'v0.2.0')));
    const before = new Set(files.keys());
    const result = buildRegistry('repo', { fs, validator, now: T1 });
    expect(result.refusals.some((r) => r.startsWith('crm/block.json:'))).toBe(true);
    expect(new Set(files.keys())).toEqual(before);
  });

  it('packs missing versions byte-identical to packBytes and emits valid docs', () => {
    const { fs, files } = freshRepo();
    const result = buildRegistry('repo', { fs, validator, now: T1 });
    expect(result.refusals).toEqual([]);
    expect(result.packed.map((p) => `${p.name}@${p.version}`)).toEqual([
      'audit@0.1.0',
      'crm@0.2.0',
    ]);

    // Byte identity with `ion-drive block pack`'s renderer (code embedded, sorted).
    const expected = packBytes({
      name: 'crm',
      version: '0.2.0',
      title: 'CRM',
      dependencies: { audit: '^0.1.0' },
      code: [
        { path: 'index.ts', contents: 'export default 1;\n' },
        { path: 'util/helpers.ts', contents: 'export const x = 2;\n' },
      ],
    });
    expect(files.get('repo/crm/dist/0.2.0/block.json')).toEqual(expected);

    const doc = readJson(files, 'repo/registry/blocks/crm.json') as unknown as Doc & {
      repository: string;
    };
    expect(doc.latest).toBe('0.2.0');
    expect(doc.repository).toBe('https://github.com/acme/blocks');
    expect(doc.versions['0.2.0']).toMatchObject({
      artifactUrl: '../../crm/dist/0.2.0/block.json',
      digest: computeDigest(expected),
      size: expected.byteLength,
      publishedAt: '2026-07-08T10:00:00Z',
      dependencies: { audit: '^0.1.0' },
      status: 'active',
    });

    const index = readJson(files, 'repo/registry/index.json');
    expect(index).toMatchObject({
      schemaVersion: 1,
      name: 'Test Registry',
      generatedAt: '2026-07-08T10:00:00Z',
    });
    expect(index.blocks).toMatchObject({
      crm: { latest: '0.2.0', blockUrl: 'blocks/crm.json', trust: 'official' },
      audit: { latest: '0.1.0', blockUrl: 'blocks/audit.json', trust: 'official' },
    });
  });

  it('is a no-op on the second run, and --check reports nothing', () => {
    const { fs } = freshRepo();
    buildRegistry('repo', { fs, validator, now: T1 });
    const second = buildRegistry('repo', { fs, validator, now: T2 });
    expect(second.refusals).toEqual([]);
    expect(second.packed).toEqual([]);
    expect(second.wrote).toEqual([]);
    const check = buildRegistry('repo', { fs, validator, now: T2, check: true });
    expect(check.wrote).toEqual([]);
  });

  it('a version bump emits exactly the new dist + appended entry, old entries preserved', () => {
    const { fs, files } = freshRepo();
    buildRegistry('repo', { fs, validator, now: T1 });
    const oldEntry = (readJson(files, 'repo/registry/blocks/crm.json') as unknown as Doc).versions[
      '0.2.0'
    ];

    files.set(
      'repo/crm/block.json',
      encoder.encode(manifestJson('crm', '0.3.0', { dependencies: { audit: '^0.1.0' } })),
    );
    const result = buildRegistry('repo', { fs, validator, now: T2 });
    expect(result.refusals).toEqual([]);
    expect(result.packed.map((p) => `${p.name}@${p.version}`)).toEqual(['crm@0.3.0']);
    expect(result.wrote.sort()).toEqual([
      'repo/crm/dist/0.3.0/block.json',
      'repo/registry/blocks/crm.json',
      'repo/registry/index.json',
    ]);

    const doc = readJson(files, 'repo/registry/blocks/crm.json') as unknown as Doc;
    expect(doc.latest).toBe('0.3.0');
    expect(doc.versions['0.2.0']).toEqual(oldEntry); // preserved verbatim
    expect(doc.versions['0.3.0']).toMatchObject({ publishedAt: '2026-07-09T11:30:00Z' });
    // The 0.2.0 artifact was not rewritten.
    expect(result.wrote).not.toContain('repo/crm/dist/0.2.0/block.json');
  });

  it('refuses a tampered released artifact by name (immutability guard)', () => {
    const { fs, files } = freshRepo();
    buildRegistry('repo', { fs, validator, now: T1 });
    // Tamper: current-version artifact no longer matches the sources.
    files.set('repo/crm/dist/0.2.0/block.json', encoder.encode('{"tampered":true}\n'));
    const result = buildRegistry('repo', { fs, validator, now: T2 });
    expect(result.refusals.join('\n')).toMatch(/crm\/dist\/0\.2\.0\/block\.json/);
    expect(result.refusals.join('\n')).toMatch(/immutable/);
  });

  it('refuses a mutated existing version entry by name', () => {
    const { fs, files } = freshRepo();
    buildRegistry('repo', { fs, validator, now: T1 });
    const doc = readJson(files, 'repo/registry/blocks/crm.json') as unknown as Doc;
    const entry = doc.versions['0.2.0'];
    if (!entry) throw new Error('missing entry');
    entry.digest = `sha256:${'0'.repeat(64)}`;
    files.set('repo/registry/blocks/crm.json', encoder.encode(`${JSON.stringify(doc, null, 2)}\n`));
    const result = buildRegistry('repo', { fs, validator, now: T2 });
    expect(result.refusals.join('\n')).toMatch(/versions\["0\.2\.0"\] no longer matches/);
  });

  it('a deleted dist artifact for a released version fails --check', () => {
    const { fs, files } = freshRepo();
    buildRegistry('repo', { fs, validator, now: T1 });
    files.delete('repo/crm/dist/0.2.0/block.json');
    const result = buildRegistry('repo', { fs, validator, now: T2, check: true });
    expect(result.refusals.join('\n')).toMatch(/missing artifact for released version 0\.2\.0/);
  });

  it('index latest drift is caught by --check (and nothing is written)', () => {
    const { fs, files } = freshRepo();
    buildRegistry('repo', { fs, validator, now: T1 });
    const index = readJson(files, 'repo/registry/index.json') as {
      blocks: Record<string, { latest: string }>;
    };
    const crmEntry = index.blocks.crm;
    if (!crmEntry) throw new Error('missing index entry');
    crmEntry.latest = '9.9.9';
    files.set('repo/registry/index.json', encoder.encode(`${JSON.stringify(index, null, 2)}\n`));
    const before = files.get('repo/registry/index.json');

    const result = buildRegistry('repo', { fs, validator, now: T2, check: true });
    expect(result.refusals).toEqual([]);
    expect(result.wrote).toEqual(['repo/registry/index.json']);
    expect(files.get('repo/registry/index.json')).toBe(before); // --check never writes
  });

  it('sets attestationUrl when the bundle appears (D5 — the sole legal entry mutation)', () => {
    const { fs, files } = freshRepo();
    buildRegistry('repo', { fs, validator, now: T1 });
    files.set('repo/crm/dist/0.2.0/block.json.sigstore.json', encoder.encode('{"bundle":1}'));

    // --check treats the pending absent→present as a would-be change.
    const check = buildRegistry('repo', { fs, validator, now: T2, check: true });
    expect(check.wrote).toEqual(['repo/registry/blocks/crm.json']);

    const result = buildRegistry('repo', { fs, validator, now: T2 });
    expect(result.refusals).toEqual([]);
    expect(result.wrote).toEqual(['repo/registry/blocks/crm.json']);
    const doc = readJson(files, 'repo/registry/blocks/crm.json') as unknown as Doc;
    expect(doc.versions['0.2.0']?.attestationUrl).toBe(
      '../../crm/dist/0.2.0/block.json.sigstore.json',
    );

    // Idempotent thereafter — an existing attestationUrl is never touched.
    const again = buildRegistry('repo', { fs, validator, now: T2 });
    expect(again.wrote).toEqual([]);
  });

  it('--block limits packing to one block while the index spans all', () => {
    const { fs, files } = freshRepo();
    buildRegistry('repo', { fs, validator, now: T1 });
    files.set('repo/crm/block.json', encoder.encode(manifestJson('crm', '0.3.0')));
    files.set('repo/audit/block.json', encoder.encode(manifestJson('audit', '0.2.0')));

    const result = buildRegistry('repo', { fs, validator, now: T2, block: 'crm' });
    expect(result.packed.map((p) => p.name)).toEqual(['crm']);
    const index = readJson(files, 'repo/registry/index.json') as {
      blocks: Record<string, { latest: string }>;
    };
    expect(index.blocks.crm?.latest).toBe('0.3.0');
    expect(index.blocks.audit?.latest).toBe('0.1.0'); // untouched, from its on-disk doc
    expect(files.has('repo/audit/dist/0.2.0/block.json')).toBe(false);
  });

  it('--block refuses an unknown block name', () => {
    const { fs } = freshRepo();
    const result = buildRegistry('repo', { fs, validator, now: T1, block: 'nope' });
    expect(result.refusals.join('\n')).toMatch(/--block nope: no such block directory/);
  });

  it('validates a hand-maintained registries.json when present', () => {
    const { fs, files } = freshRepo();
    files.set(
      'repo/registries.json',
      encoder.encode(JSON.stringify({ schemaVersion: 1, registries: [{ namespace: 'BAD' }] })),
    );
    const result = buildRegistry('repo', { fs, validator, now: T1 });
    expect(result.refusals.join('\n')).toMatch(/registries\.json:/);
  });
});

describe('computeLatest', () => {
  it('picks the highest active non-prerelease, skipping yanked and prerelease', () => {
    expect(
      computeLatest({
        '1.1.0': { status: 'yanked' },
        '1.2.0-rc.1': { status: 'active' },
        '1.0.0': { status: 'active' },
      }),
    ).toBe('1.0.0');
  });

  it('falls back to an active prerelease, then to any version at all', () => {
    expect(
      computeLatest({ '1.0.0': { status: 'yanked' }, '1.1.0-rc.1': { status: 'active' } }),
    ).toBe('1.1.0-rc.1');
    expect(computeLatest({ '1.0.0': { status: 'yanked' }, '0.9.0': { status: 'yanked' } })).toBe(
      '1.0.0',
    );
  });
});

describe('applyStatusEdit (registry yank / deprecate — AC6 writer half)', () => {
  function publishedRepo() {
    const repo = freshRepo();
    buildRegistry('repo', { fs: repo.fs, validator, now: T1 });
    repo.files.set(
      'repo/crm/block.json',
      encoder.encode(manifestJson('crm', '0.3.0', { dependencies: { audit: '^0.1.0' } })),
    );
    buildRegistry('repo', { fs: repo.fs, validator, now: T1 });
    return repo;
  }

  it('yank stamps status/statusReason/yankedAt and recomputes latest in doc AND index', () => {
    const { fs, files } = publishedRepo();
    const result = applyStatusEdit('repo', 'crm@0.3.0', 'yanked', {
      fs,
      now: T2,
      reason: 'ships a broken migration',
    });
    expect(result).toEqual({ name: 'crm', version: '0.3.0', status: 'yanked', latest: '0.2.0' });

    const doc = readJson(files, 'repo/registry/blocks/crm.json') as unknown as Doc;
    expect(doc.versions['0.3.0']).toMatchObject({
      status: 'yanked',
      statusReason: 'ships a broken migration',
      yankedAt: '2026-07-09T11:30:00Z',
    });
    expect(doc.latest).toBe('0.2.0');

    const index = readJson(files, 'repo/registry/index.json') as {
      generatedAt: string;
      blocks: Record<string, { latest: string }>;
    };
    expect(index.blocks.crm?.latest).toBe('0.2.0');
    expect(index.generatedAt).toBe('2026-07-09T11:30:00Z');
    // The edited docs still satisfy the strict parsers.
    parseRegistryBlock(doc);
    parseRegistryIndex(index);
  });

  it('deprecate keeps the version selectable metadata-wise and clears yankedAt', () => {
    const { fs, files } = publishedRepo();
    applyStatusEdit('repo', 'crm@0.3.0', 'yanked', { fs, now: T2 });
    const result = applyStatusEdit('repo', 'crm@0.3.0', 'deprecated', {
      fs,
      now: T2,
      reason: 'superseded',
    });
    expect(result.latest).toBe('0.2.0'); // latest prefers active versions
    const doc = readJson(files, 'repo/registry/blocks/crm.json') as unknown as Doc;
    expect(doc.versions['0.3.0']).toMatchObject({
      status: 'deprecated',
      statusReason: 'superseded',
    });
    expect(doc.versions['0.3.0']?.yankedAt).toBeUndefined();
  });

  it('refuses unknown names, unknown versions, and malformed refs', () => {
    const { fs } = publishedRepo();
    expect(() => applyStatusEdit('repo', 'nope@1.0.0', 'yanked', { fs, now: T2 })).toThrow(
      RegistryBuildError,
    );
    expect(() => applyStatusEdit('repo', 'crm@9.9.9', 'yanked', { fs, now: T2 })).toThrow(
      /Unknown version "9\.9\.9"/,
    );
    expect(() => applyStatusEdit('repo', 'crm', 'yanked', { fs, now: T2 })).toThrow(
      /<name>@<version>/,
    );
  });
});
