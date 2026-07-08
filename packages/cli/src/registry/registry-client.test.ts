/**
 * Unit tests for the registry client's pure manifest helpers — specifically
 * `dependenciesOf`, which must accept only the manifest-v1 record form
 * (spec-02): the legacy array form would otherwise leak `Object.keys` indices
 * ("0", "1", …) into dependency resolution as fake block names.
 */

import { describe, expect, it } from 'vitest';
import { type Manifest, dependenciesOf } from './registry-client.js';

describe('dependenciesOf', () => {
  it('returns the keys of a record-form dependencies map', () => {
    const manifest = {
      name: 'catalog',
      dependencies: { invoicing: '^0.1.0', '@acme/billing': '*' },
    } as Manifest;
    expect(dependenciesOf(manifest)).toEqual(['invoicing', '@acme/billing']);
  });

  it('returns [] when dependencies is absent', () => {
    expect(dependenciesOf({ name: 'crm' } as Manifest)).toEqual([]);
  });

  it('returns [] for the legacy array form (never array indices)', () => {
    const manifest = { name: 'invoicing', dependencies: ['crm'] } as unknown as Manifest;
    expect(dependenciesOf(manifest)).toEqual([]);
  });

  it('returns [] for non-object dependencies values', () => {
    expect(dependenciesOf({ name: 'x', dependencies: null } as unknown as Manifest)).toEqual([]);
    expect(dependenciesOf({ name: 'x', dependencies: 'crm' } as unknown as Manifest)).toEqual([]);
  });
});
