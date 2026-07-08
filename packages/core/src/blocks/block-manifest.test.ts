/**
 * Unit tests for block manifest parsing + validation, including the manifest
 * v1 semver grammar (spec-02): strict versions, name → range dependency
 * records, `requires.core`, and the shared `splitBlockRef` helper.
 */

import { describe, expect, it } from 'vitest';
import { BlockManifestError, parseManifest } from './block-manifest.js';
import { splitBlockRef } from './block-types.js';

const validManifest = {
  name: 'crm',
  title: 'CRM',
  objects: [
    {
      name: 'contacts',
      displayName: 'Contacts',
      fields: [{ name: 'email', displayName: 'Email', columnType: 'email' }],
    },
  ],
};

describe('parseManifest', () => {
  it('accepts a minimal valid manifest and applies defaults', () => {
    const m = parseManifest(validManifest);
    expect(m.name).toBe('crm');
    expect(m.version).toBe('0.1.0'); // default applied
    expect(m.dependencies).toEqual({});
    expect(m.categories).toEqual([]);
    expect(m.objects).toHaveLength(1);
  });

  it('rejects an unknown column type', () => {
    const bad = {
      ...validManifest,
      objects: [
        {
          name: 'contacts',
          displayName: 'Contacts',
          fields: [{ name: 'x', displayName: 'X', columnType: 'not_a_type' }],
        },
      ],
    };
    expect(() => parseManifest(bad)).toThrow(BlockManifestError);
  });

  it('rejects an invalid block name', () => {
    expect(() => parseManifest({ ...validManifest, name: 'Bad Name!' })).toThrow(
      BlockManifestError,
    );
  });

  it('rejects duplicate object names', () => {
    const dup = {
      ...validManifest,
      objects: [validManifest.objects[0], validManifest.objects[0]],
    };
    expect(() => parseManifest(dup)).toThrow(/duplicate object/);
  });

  it('rejects seed data referencing an unknown object', () => {
    const bad = { ...validManifest, seed: { widgets: [{ a: 1 }] } };
    expect(() => parseManifest(bad)).toThrow(/unknown object/);
  });

  it('rejects a block depending on itself', () => {
    const bad = { ...validManifest, dependencies: { crm: '*' } };
    expect(() => parseManifest(bad)).toThrow(/cannot depend on itself/);
  });

  it('rejects a namespaced self-dependency (singletons per server)', () => {
    const bad = { ...validManifest, dependencies: { '@acme/crm': '^0.1.0' } };
    expect(() => parseManifest(bad)).toThrow(/cannot depend on itself/);
  });

  it('rejects the same bare name under two namespace forms (ambiguous source)', () => {
    const bad = {
      ...validManifest,
      name: 'invoicing',
      seed: {},
      dependencies: { crm: '^0.2.0', '@ion/crm': '^0.2.0' },
    };
    expect(() => parseManifest(bad)).toThrow(/ambiguous source/);
  });

  // --- Manifest v1 semver grammar (spec-02 AC1/AC2) ---

  it('rejects a non-semver version ("1.0")', () => {
    expect(() => parseManifest({ ...validManifest, version: '1.0' })).toThrow(
      /version: must be a canonical semver version/,
    );
  });

  it('rejects a v-prefixed version ("v1.0.0")', () => {
    expect(() => parseManifest({ ...validManifest, version: 'v1.0.0' })).toThrow(
      /version: must be a canonical semver version/,
    );
  });

  it('rejects build metadata ("1.0.0+build.1")', () => {
    expect(() => parseManifest({ ...validManifest, version: '1.0.0+build.1' })).toThrow(
      /version: must be a canonical semver version/,
    );
  });

  it('rejects a non-range dependency value ("latest")', () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        name: 'invoicing',
        seed: {},
        dependencies: { crm: 'latest' },
      }),
    ).toThrow(/must be a valid semver range/);
  });

  it('rejects the legacy array dependencies form with a pointer at the record form', () => {
    expect(() => parseManifest({ ...validManifest, dependencies: ['crm'] })).toThrow(
      /legacy array form.*record/,
    );
  });

  it('accepts record dependencies, requires.core, and the "*" escape hatch', () => {
    const m = parseManifest({
      ...validManifest,
      name: 'invoicing',
      seed: {},
      version: '1.2.3-rc.1',
      dependencies: { crm: '^0.2.0', '@acme/billing': '>=1.2 <2', audit: '*' },
      requires: { core: '>=0.2.0 <1.0.0' },
    });
    expect(m.version).toBe('1.2.3-rc.1');
    expect(m.dependencies).toEqual({ crm: '^0.2.0', '@acme/billing': '>=1.2 <2', audit: '*' });
    expect(m.requires.core).toBe('>=0.2.0 <1.0.0');
  });

  it('rejects an invalid requires.core range', () => {
    expect(() => parseManifest({ ...validManifest, requires: { core: 'not-a-range' } })).toThrow(
      /requires\.core: must be a valid semver range/,
    );
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    const bad = { ...validManifest, bogus: true };
    expect(() => parseManifest(bad)).toThrow(BlockManifestError);
  });

  it('surfaces aggregated issues on the error', () => {
    try {
      parseManifest({ name: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockManifestError);
      expect((err as BlockManifestError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('splitBlockRef', () => {
  it.each([
    ['crm', { name: 'crm' }],
    ['audit_log', { name: 'audit_log' }],
    ['@acme/billing', { namespace: '@acme', name: 'billing' }],
    ['@a-b/c-d', { namespace: '@a-b', name: 'c-d' }],
  ] as const)('splits %s', (ref, expected) => {
    expect(splitBlockRef(ref)).toEqual(expected);
  });

  it.each([
    'crm@0.2.0', // version pinning is CLI argument grammar, not part of a ref
    '@Acme/x', // uppercase namespace
    '@a/b/c', // extra path segment
    '-bad', // must start with a letter
    '', // empty
    '@acme/', // namespace without a name
    '@/x', // empty namespace
  ])('rejects %j', (ref) => {
    expect(splitBlockRef(ref)).toBeNull();
  });
});
