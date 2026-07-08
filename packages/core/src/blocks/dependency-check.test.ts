/**
 * Unit tests for the pure dependency-range evaluation (spec-02): missing vs
 * out-of-range classification, namespaced-ref → bare-ledger-name matching,
 * non-semver installed versions, and the `"*"` escape hatch.
 */

import { describe, expect, it } from 'vitest';
import { dependencyNames, evaluateDependencies } from './dependency-check.js';

describe('evaluateDependencies', () => {
  it('returns empty results for an empty record', () => {
    expect(evaluateDependencies({}, new Map())).toEqual({ missing: [], outOfRange: [] });
  });

  it('reports a dependency with no installed block as missing (by declared ref)', () => {
    const result = evaluateDependencies({ crm: '^0.2.0', '@acme/billing': '*' }, new Map());
    expect(result.missing).toEqual(['crm', '@acme/billing']);
    expect(result.outOfRange).toEqual([]);
  });

  it('accepts an installed dependency whose version satisfies the range', () => {
    const result = evaluateDependencies({ crm: '^0.2.0' }, new Map([['crm', '0.2.4']]));
    expect(result).toEqual({ missing: [], outOfRange: [] });
  });

  it('reports the name, installed version, and range for an out-of-range dependency', () => {
    const result = evaluateDependencies({ crm: '^0.2.0' }, new Map([['crm', '0.1.0']]));
    expect(result.missing).toEqual([]);
    expect(result.outOfRange).toEqual([
      { name: 'crm', installedVersion: '0.1.0', range: '^0.2.0' },
    ]);
  });

  it('matches a namespaced ref against the bare ledger name', () => {
    const installed = new Map([['crm', '0.2.0']]);
    expect(evaluateDependencies({ '@acme/crm': '^0.2.0' }, installed)).toEqual({
      missing: [],
      outOfRange: [],
    });
    expect(evaluateDependencies({ '@acme/crm': '^1.0.0' }, installed).outOfRange).toEqual([
      { name: 'crm', installedVersion: '0.2.0', range: '^1.0.0' },
    ]);
  });

  it('treats a non-semver installed version as out-of-range for a real range', () => {
    const result = evaluateDependencies({ crm: '^0.2.0' }, new Map([['crm', 'dev-build']]));
    expect(result.outOfRange).toEqual([
      { name: 'crm', installedVersion: 'dev-build', range: '^0.2.0' },
    ]);
  });

  it('"*" is satisfied by anything installed, even a non-semver version', () => {
    expect(evaluateDependencies({ crm: '*' }, new Map([['crm', 'dev-build']]))).toEqual({
      missing: [],
      outOfRange: [],
    });
  });
});

describe('dependencyNames', () => {
  it('strips namespaces down to bare ledger names', () => {
    expect(dependencyNames({ crm: '^0.2.0', '@acme/billing': '*' })).toEqual(['crm', 'billing']);
  });
});
