/**
 * Unit tests for the block registry protocol v1 (ADR-022 / spec-01):
 * parse helpers, rejection rules, URL helpers, and the JSON-Schema drift guard.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderRegistryJsonSchemas } from './registry-json-schemas.js';
import {
  RegistryParseError,
  isPermittedRegistryUrl,
  parseRegistriesDirectory,
  parseRegistryBlock,
  parseRegistryIndex,
  resolveRegistryUrl,
} from './registry-types.js';

// Real 64-lowercase-hex digests. The spec's §4 example elides its digests
// ("sha256:ab12…64 hex chars…"), so per AC5 we substitute format-valid values
// — the only deviation from the verbatim spec examples.
const DIGEST_A = `sha256:${'ab12'.repeat(16)}`;
const DIGEST_B = `sha256:${'cd34'.repeat(16)}`;
const DIGEST_C = `sha256:${'ef56'.repeat(16)}`;

// --- Spec examples (AC5) — §3/§4/§6 verbatim except the digest substitution ---

const specIndexExample = {
  $schema: 'https://iondrive.dev/schemas/registry-index.v1.json',
  schemaVersion: 1,
  name: 'Ion Drive Official Blocks',
  description: 'The main Ion Drive block registry.',
  homepage: 'https://registry.iondrive.dev',
  generatedAt: '2026-07-08T00:00:00Z',
  blocks: {
    crm: {
      title: 'CRM',
      description: 'Companies, contacts, deals, and activities.',
      categories: ['sales', 'crm'],
      latest: '0.2.0',
      blockUrl: 'blocks/crm.json',
      trust: 'official',
    },
  },
};

const specBlockExample = {
  $schema: 'https://iondrive.dev/schemas/registry-block.v1.json',
  schemaVersion: 1,
  name: 'crm',
  title: 'CRM',
  description: 'Companies, contacts, deals, and activities.',
  categories: ['sales', 'crm'],
  repository: 'https://github.com/jaredgrabill/ion-drive-blocks',
  homepage: 'https://registry.iondrive.dev/blocks/crm',
  latest: '0.2.0',
  versions: {
    '0.2.0': {
      artifactUrl: '../../crm/dist/0.2.0/block.json',
      digest: DIGEST_A,
      size: 48213,
      publishedAt: '2026-07-08T00:00:00Z',
      dependencies: {},
      requires: { core: '>=0.2.0 <1.0.0' },
      attestationUrl: '../../crm/dist/0.2.0/block.json.sigstore.json',
      status: 'active',
    },
    '0.1.0': {
      artifactUrl: '../../crm/dist/0.1.0/block.json',
      digest: DIGEST_B,
      size: 40110,
      publishedAt: '2026-07-01T00:00:00Z',
      dependencies: {},
      requires: {},
      status: 'deprecated',
      statusReason: 'Superseded by 0.2.0 (renamed pipeline stages).',
    },
  },
  advisories: [],
};

const specDirectoryExample = {
  $schema: 'https://iondrive.dev/schemas/registries-directory.v1.json',
  schemaVersion: 1,
  registries: [
    {
      namespace: '@ion',
      url: 'https://registry.iondrive.dev/index.json',
      owner: 'IonShift Labs',
      repository: 'https://github.com/jaredgrabill/ion-drive-blocks',
      description: 'Official Ion Drive blocks.',
      trust: 'official',
    },
    {
      namespace: '@acme',
      url: 'https://blocks.acme.dev/registry/index.json',
      owner: 'Acme Corp',
      description: "Acme's public Ion Drive blocks.",
      trust: 'listed',
    },
  ],
};

// --- Full fixture registry (AC3) — exercises every field ---

const fullBlockFixture = {
  $schema: 'https://iondrive.dev/schemas/registry-block.v1.json',
  schemaVersion: 1,
  name: 'invoicing',
  title: 'Invoicing',
  description: 'Invoices, line items, payments, Stripe payment links.',
  categories: ['finance', 'billing'],
  repository: 'https://github.com/jaredgrabill/ion-drive-blocks',
  homepage: 'https://registry.iondrive.dev/blocks/invoicing',
  latest: '1.1.0',
  versions: {
    // Absolute artifact URL (CDN) + non-empty dependencies + requires with the
    // catchall exercised (a display-only handlers list next to core).
    '1.1.0': {
      artifactUrl: 'https://cdn.iondrive.dev/blocks/invoicing/1.1.0/block.json',
      digest: DIGEST_A,
      size: 52340,
      publishedAt: '2026-07-08T00:00:00Z',
      dependencies: { crm: '^0.2.0' },
      requires: { core: '>=0.2.0 <1.0.0', handlers: ['invoicing/create_payment_link'] },
      attestationUrl: 'https://cdn.iondrive.dev/blocks/invoicing/1.1.0/block.json.sigstore.json',
      status: 'active',
    },
    // Relative artifact URL with `../../` traversal (legal — URL space).
    '1.0.0': {
      artifactUrl: '../../invoicing/dist/1.0.0/block.json',
      digest: DIGEST_B,
      size: 50100,
      publishedAt: '2026-07-01T00:00:00Z',
      dependencies: { crm: '^0.2.0' },
      requires: { core: '>=0.2.0 <1.0.0' },
      status: 'deprecated',
      statusReason: 'Superseded by 1.1.0.',
    },
    // Yanked version with the required yankedAt.
    '0.9.0': {
      artifactUrl: '../../invoicing/dist/0.9.0/block.json',
      digest: DIGEST_C,
      size: 48000,
      publishedAt: '2026-06-20T00:00:00Z',
      dependencies: {},
      requires: {},
      status: 'yanked',
      statusReason: 'Logged raw Stripe payloads.',
      yankedAt: '2026-07-08T00:00:00Z',
    },
  },
  // The spec §4 advisory example, verbatim.
  advisories: [
    {
      id: 'IONB-2026-0001',
      severity: 'critical',
      affectedVersions: '<0.2.1',
      description: '0.2.0 shipped a webhook handler that logged raw Stripe payloads.',
      url: 'https://github.com/jaredgrabill/ion-drive-blocks/security/advisories/…',
      createdAt: '2026-07-08T00:00:00Z',
    },
  ],
};

/** Minimal valid per-block file, with per-version overrides for rejection tests. */
function minimalBlock(entryOverrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    name: 'crm',
    latest: '0.1.0',
    versions: {
      '0.1.0': {
        artifactUrl: 'dist/0.1.0/block.json',
        digest: DIGEST_A,
        size: 100,
        publishedAt: '2026-07-08T00:00:00Z',
        dependencies: {},
        requires: {},
        status: 'active',
        ...entryOverrides,
      },
    },
  };
}

describe('parseRegistryIndex', () => {
  it("round-trips the spec's §3 example", () => {
    expect(parseRegistryIndex(specIndexExample)).toEqual(specIndexExample);
  });

  it('accepts an empty blocks map', () => {
    const index = {
      schemaVersion: 1,
      name: 'Empty Registry',
      generatedAt: '2026-07-08T00:00:00Z',
      blocks: {},
    };
    expect(parseRegistryIndex(index).blocks).toEqual({});
  });

  it('rejects a legacy index (no schemaVersion) with the exact pre-release message', () => {
    try {
      parseRegistryIndex({ name: 'Old Registry', blocks: {} });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryParseError);
      expect((err as RegistryParseError).message).toBe(
        'registry is in the pre-release unversioned format — ask its owner to run `ion-drive registry build`',
      );
    }
  });

  it('rejects schemaVersion 2 as an unsupported format', () => {
    expect(() => parseRegistryIndex({ ...specIndexExample, schemaVersion: 2 })).toThrow(
      /unsupported format.*2/,
    );
  });

  it('rejects an entry whose latest is not semver', () => {
    const bad = {
      ...specIndexExample,
      blocks: { crm: { latest: 'not-a-version', blockUrl: 'blocks/crm.json' } },
    };
    expect(() => parseRegistryIndex(bad)).toThrow(/canonical semver version/);
  });

  it('rejects an entry missing blockUrl', () => {
    const bad = { ...specIndexExample, blocks: { crm: { latest: '0.2.0' } } };
    expect(() => parseRegistryIndex(bad)).toThrow(RegistryParseError);
  });

  it('rejects a block key that violates the name grammar', () => {
    const bad = {
      ...specIndexExample,
      blocks: { 'Bad Name!': { latest: '0.2.0', blockUrl: 'blocks/x.json' } },
    };
    expect(() => parseRegistryIndex(bad)).toThrow(/kebab\/snake case/);
  });

  it('rejects a non-UTC generatedAt', () => {
    expect(() => parseRegistryIndex({ ...specIndexExample, generatedAt: '2026-07-08' })).toThrow(
      /ISO-8601 UTC/,
    );
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    expect(() => parseRegistryIndex({ ...specIndexExample, bogus: true })).toThrow(
      RegistryParseError,
    );
  });
});

describe('parseRegistryBlock', () => {
  it("round-trips the spec's §4 example", () => {
    expect(parseRegistryBlock(specBlockExample)).toEqual(specBlockExample);
  });

  it('round-trips the full fixture (every field, all three statuses, advisories)', () => {
    expect(parseRegistryBlock(fullBlockFixture)).toEqual(fullBlockFixture);
  });

  it('defaults advisories to [] when omitted', () => {
    expect(parseRegistryBlock(minimalBlock()).advisories).toEqual([]);
  });

  it('rejects schemaVersion 2 as an unsupported format', () => {
    expect(() => parseRegistryBlock({ ...minimalBlock(), schemaVersion: 2 })).toThrow(
      /unsupported format.*2/,
    );
  });

  it('rejects a malformed digest (wrong prefix, short, uppercase)', () => {
    const cases = [
      `md5:${'ab12'.repeat(16)}`, // wrong prefix
      `sha256:${'ab12'.repeat(16).slice(1)}`, // 63 chars
      `sha256:${'AB12'.repeat(16)}`, // uppercase hex
    ];
    for (const digest of cases) {
      expect(() => parseRegistryBlock(minimalBlock({ digest }))).toThrow(/64 lowercase hex/);
    }
  });

  it('rejects a bad semver range in dependencies', () => {
    expect(() => parseRegistryBlock(minimalBlock({ dependencies: { crm: '!!!' } }))).toThrow(
      /valid semver range/,
    );
  });

  it('rejects a bad semver range in requires.core', () => {
    expect(() => parseRegistryBlock(minimalBlock({ requires: { core: '>= banana' } }))).toThrow(
      /valid semver range/,
    );
  });

  it('rejects a missing latest', () => {
    const { latest: _omitted, ...bad } = minimalBlock();
    expect(() => parseRegistryBlock(bad)).toThrow(RegistryParseError);
  });

  it('rejects a latest that is not a key of versions', () => {
    expect(() => parseRegistryBlock({ ...minimalBlock(), latest: '9.9.9' })).toThrow(
      /latest "9.9.9" is not a key of versions/,
    );
  });

  it('rejects non-canonical version keys', () => {
    for (const key of ['v0.2.0', '0.2']) {
      const bad = {
        schemaVersion: 1,
        name: 'crm',
        latest: '0.2.0',
        versions: { [key]: minimalBlock().versions['0.1.0'] },
      };
      expect(() => parseRegistryBlock(bad)).toThrow(/canonical semver version/);
    }
  });

  it('rejects a yanked version without yankedAt', () => {
    expect(() => parseRegistryBlock(minimalBlock({ status: 'yanked' }))).toThrow(
      /yanked but has no yankedAt/,
    );
  });

  it('rejects a non-UTC publishedAt', () => {
    expect(() => parseRegistryBlock(minimalBlock({ publishedAt: 'yesterday' }))).toThrow(
      /ISO-8601 UTC/,
    );
  });

  it('rejects a negative or non-integer size', () => {
    expect(() => parseRegistryBlock(minimalBlock({ size: -1 }))).toThrow(RegistryParseError);
    expect(() => parseRegistryBlock(minimalBlock({ size: 1.5 }))).toThrow(RegistryParseError);
  });

  it('rejects a bad advisory severity', () => {
    const bad = {
      ...minimalBlock(),
      advisories: [
        {
          id: 'IONB-2026-0002',
          severity: 'catastrophic',
          affectedVersions: '<0.1.0',
          description: 'Bad.',
          createdAt: '2026-07-08T00:00:00Z',
        },
      ],
    };
    expect(() => parseRegistryBlock(bad)).toThrow(RegistryParseError);
  });

  it('rejects a bad advisory affectedVersions range', () => {
    const bad = {
      ...minimalBlock(),
      advisories: [
        {
          id: 'IONB-2026-0003',
          severity: 'low',
          affectedVersions: '!!!',
          description: 'Bad.',
          createdAt: '2026-07-08T00:00:00Z',
        },
      ],
    };
    expect(() => parseRegistryBlock(bad)).toThrow(/valid semver range/);
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    expect(() => parseRegistryBlock({ ...minimalBlock(), bogus: true })).toThrow(
      RegistryParseError,
    );
  });

  it('surfaces multiple aggregated issues on the error', () => {
    try {
      parseRegistryBlock({ schemaVersion: 1 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryParseError);
      expect((err as RegistryParseError).issues.length).toBeGreaterThan(1);
    }
  });
});

describe('parseRegistriesDirectory', () => {
  it("round-trips the spec's §6 example", () => {
    expect(parseRegistriesDirectory(specDirectoryExample)).toEqual(specDirectoryExample);
  });

  it('rejects schemaVersion 2 as an unsupported format', () => {
    expect(() => parseRegistriesDirectory({ ...specDirectoryExample, schemaVersion: 2 })).toThrow(
      /unsupported format.*2/,
    );
  });

  it('rejects bad namespaces', () => {
    for (const namespace of ['acme', '@Acme']) {
      const bad = {
        schemaVersion: 1,
        registries: [{ namespace, url: 'https://blocks.acme.dev/index.json' }],
      };
      expect(() => parseRegistriesDirectory(bad)).toThrow(/@acme/);
    }
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    expect(() => parseRegistriesDirectory({ ...specDirectoryExample, bogus: true })).toThrow(
      RegistryParseError,
    );
  });
});

describe('URL helpers', () => {
  it('resolves a relative URL against its containing file', () => {
    expect(resolveRegistryUrl('blocks/crm.json', 'https://r.dev/index.json')).toBe(
      'https://r.dev/blocks/crm.json',
    );
  });

  it('resolves `../../` traversal (URL space, not filesystem)', () => {
    expect(
      resolveRegistryUrl(
        '../../crm/dist/0.2.0/block.json',
        'https://r.dev/registry/blocks/crm.json',
      ),
    ).toBe('https://r.dev/crm/dist/0.2.0/block.json');
  });

  it('passes absolute URLs through unchanged', () => {
    expect(
      resolveRegistryUrl('https://cdn.dev/block.json', 'https://r.dev/registry/index.json'),
    ).toBe('https://cdn.dev/block.json');
  });

  it('permits https, permits http only for localhost/127.0.0.1, rejects the rest', () => {
    expect(isPermittedRegistryUrl('https://registry.iondrive.dev/index.json')).toBe(true);
    expect(isPermittedRegistryUrl('http://localhost:3000/index.json')).toBe(true);
    expect(isPermittedRegistryUrl('http://127.0.0.1/index.json')).toBe(true);
    expect(isPermittedRegistryUrl('http://evil.dev/index.json')).toBe(false);
    expect(isPermittedRegistryUrl('file:///C:/registry/index.json')).toBe(false);
    expect(isPermittedRegistryUrl('not a url')).toBe(false);
  });
});

describe('published JSON Schemas (drift guard)', () => {
  const rendered = renderRegistryJsonSchemas();
  const schemasDir = new URL('../../schemas/', import.meta.url);

  it('committed schema files match the Zod-rendered output byte-for-byte', () => {
    for (const [basename, text] of Object.entries(rendered)) {
      const committed = readFileSync(new URL(basename, schemasDir), 'utf8');
      expect(
        committed,
        `schemas/${basename} is out of date — run \`pnpm --filter @ion-drive/core emit:schemas\``,
      ).toBe(text);
    }
  });

  it('each schema is valid JSON with the right $id, 2020-12 $schema, and version pin', () => {
    for (const [basename, text] of Object.entries(rendered)) {
      const doc = JSON.parse(text);
      expect(doc.$id).toBe(`https://iondrive.dev/schemas/${basename}`);
      expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      // Registry wire files pin `schemaVersion: 1`; the manifest schema is
      // versioned by its filename/$id instead (spec-02).
      if (basename !== 'block-manifest.v1.json') {
        expect(doc.properties.schemaVersion.const).toBe(1);
      }
    }
  });

  it('publishes the manifest v1 schema alongside the registry schemas (spec-02)', () => {
    expect(Object.keys(rendered)).toContain('block-manifest.v1.json');
  });
});
