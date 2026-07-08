/**
 * Unit tests for the CLI's lenient protocol-v1 reader: the schemaVersion
 * format gate (with spec-01's exact legacy-index message), the load-bearing
 * field + cross-field checks, unknown-field tolerance (additive registry
 * evolution), the vendored URL helpers, and a **parity check**: a fully
 * strict fixture accepted by core's `parseRegistryIndex`/`parseRegistryBlock`
 * must be accepted by this reader too (the lenient set is a superset).
 */

// Core is a devDependency — test-only import (D1).
import { parseRegistryBlock, parseRegistryIndex } from '@ion-drive/core';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_INDEX_MESSAGE,
  RegistryError,
  isPermittedRegistryUrl,
  parseBlockDoc,
  parseIndexDoc,
  resolveRegistryUrl,
} from './protocol.js';

const URL_OF = 'https://reg.test/registry/index.json';

/** A fixture that satisfies core's *strict* schemas (the parity baseline). */
const strictIndex = {
  schemaVersion: 1,
  name: 'Test Registry',
  description: 'Fixture',
  generatedAt: '2026-07-08T00:00:00Z',
  blocks: {
    crm: {
      title: 'CRM',
      description: 'Contacts and companies.',
      latest: '0.2.0',
      blockUrl: 'blocks/crm.json',
    },
  },
};

const strictBlock = {
  schemaVersion: 1,
  name: 'crm',
  title: 'CRM',
  latest: '0.2.0',
  versions: {
    '0.2.0': {
      artifactUrl: '../../crm/dist/0.2.0/block.json',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 1234,
      publishedAt: '2026-07-08T00:00:00Z',
      dependencies: {},
      requires: { core: '>=0.2.0 <1.0.0' },
      status: 'active' as const,
    },
    '0.1.0': {
      artifactUrl: '../../crm/dist/0.1.0/block.json',
      digest: `sha256:${'b'.repeat(64)}`,
      size: 1000,
      publishedAt: '2026-07-01T00:00:00Z',
      dependencies: {},
      requires: {},
      status: 'yanked' as const,
      statusReason: 'bad release',
      yankedAt: '2026-07-02T00:00:00Z',
    },
  },
  advisories: [],
};

describe('parity with core parsers', () => {
  it('a strict fixture passes core AND the lenient reader', () => {
    expect(() => parseRegistryIndex(strictIndex)).not.toThrow();
    expect(() => parseRegistryBlock(strictBlock)).not.toThrow();
    expect(parseIndexDoc(strictIndex, URL_OF).name).toBe('Test Registry');
    expect(parseBlockDoc(strictBlock, URL_OF).latest).toBe('0.2.0');
  });
});

describe('format gate', () => {
  it('rejects a legacy (unversioned) index with the exact spec-01 message', () => {
    const legacy = { blocks: { crm: { latest: '0.1.0', versions: { '0.1.0': 'https://…' } } } };
    expect(() => parseIndexDoc(legacy, URL_OF)).toThrow(LEGACY_INDEX_MESSAGE);
    expect(LEGACY_INDEX_MESSAGE).toBe(
      'registry is in the pre-release unversioned format — ask its owner to run `ion-drive registry build`',
    );
  });

  it('rejects a future schemaVersion as unsupported', () => {
    expect(() => parseIndexDoc({ ...strictIndex, schemaVersion: 2 }, URL_OF)).toThrow(
      /unsupported format.*schemaVersion 2/,
    );
    expect(() => parseBlockDoc({ ...strictBlock, schemaVersion: 2 }, URL_OF)).toThrow(
      /unsupported format/,
    );
  });
});

describe('lenient reading', () => {
  it('tolerates unknown fields (additive registry evolution)', () => {
    const index = {
      ...strictIndex,
      futureField: { anything: true },
      blocks: { crm: { ...strictIndex.blocks.crm, downloadStats: 42 } },
    };
    expect(parseIndexDoc(index, URL_OF).blocks.crm?.latest).toBe('0.2.0');

    const block = {
      ...strictBlock,
      futureTopLevel: 1,
      versions: {
        '0.2.0': { ...strictBlock.versions['0.2.0'], sbomUrl: 'sbom.json' },
      },
      latest: '0.2.0',
    };
    expect(parseBlockDoc(block, URL_OF).versions['0.2.0']?.digest).toContain('sha256:');
  });

  it('defaults absent dependencies/requires/status/advisories', () => {
    const block = {
      schemaVersion: 1,
      name: 'tiny',
      latest: '1.0.0',
      versions: { '1.0.0': { artifactUrl: 'a.json', digest: 'sha256:x' } },
    };
    const parsed = parseBlockDoc(block, URL_OF);
    expect(parsed.versions['1.0.0']).toMatchObject({
      dependencies: {},
      requires: {},
      status: 'active',
    });
    expect(parsed.advisories).toEqual([]);
  });

  it('rejects latest not present in versions', () => {
    expect(() => parseBlockDoc({ ...strictBlock, latest: '9.9.9' }, URL_OF)).toThrow(
      /latest "9\.9\.9".*not a key of versions/,
    );
  });

  it('rejects a yanked version without yankedAt', () => {
    const block = {
      ...strictBlock,
      versions: {
        '0.2.0': strictBlock.versions['0.2.0'],
        '0.1.0': { ...strictBlock.versions['0.1.0'], yankedAt: undefined },
      },
    };
    expect(() => parseBlockDoc(block, URL_OF)).toThrow(/yanked but has no yankedAt/);
  });

  it('rejects missing load-bearing fields with the source URL in the message', () => {
    expect(() => parseIndexDoc({ schemaVersion: 1, blocks: {} }, URL_OF)).toThrow(
      new RegExp(`${URL_OF.replace(/[/.]/g, '\\$&')}.*"name"`),
    );
    expect(() =>
      parseIndexDoc(
        { ...strictIndex, blocks: { crm: { latest: '0.2.0' } } }, // no blockUrl
        URL_OF,
      ),
    ).toThrow(RegistryError);
  });
});

describe('URL helpers (vendored from core — keep identical)', () => {
  it('resolves relative URLs against the containing file, traversal included', () => {
    expect(resolveRegistryUrl('blocks/crm.json', URL_OF)).toBe(
      'https://reg.test/registry/blocks/crm.json',
    );
    expect(
      resolveRegistryUrl(
        '../../crm/dist/0.2.0/block.json',
        'https://reg.test/registry/blocks/crm.json',
      ),
    ).toBe('https://reg.test/crm/dist/0.2.0/block.json');
    expect(resolveRegistryUrl('https://cdn.test/x.json', URL_OF)).toBe('https://cdn.test/x.json');
  });

  it('permits https everywhere, http only on localhost', () => {
    expect(isPermittedRegistryUrl('https://reg.test/index.json')).toBe(true);
    expect(isPermittedRegistryUrl('http://localhost:8080/index.json')).toBe(true);
    expect(isPermittedRegistryUrl('http://127.0.0.1:9000/index.json')).toBe(true);
    expect(isPermittedRegistryUrl('http://reg.test/index.json')).toBe(false);
    expect(isPermittedRegistryUrl('file:///c:/registry/index.json')).toBe(false);
    expect(isPermittedRegistryUrl('not a url')).toBe(false);
  });
});
