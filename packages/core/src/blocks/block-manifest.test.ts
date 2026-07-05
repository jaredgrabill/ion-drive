/**
 * Unit tests for block manifest parsing + validation.
 */

import { describe, expect, it } from 'vitest';
import { BlockManifestError, parseManifest } from './block-manifest.js';

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
    expect(m.dependencies).toEqual([]);
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
    const bad = { ...validManifest, dependencies: ['crm'] };
    expect(() => parseManifest(bad)).toThrow(/cannot depend on itself/);
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
