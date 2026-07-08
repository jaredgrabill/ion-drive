/**
 * Unit tests for the CLI ref grammar (spec-03 §2) — a table of accepted and
 * rejected refs, the local-path/URL classification rules (Windows backslash
 * paths keep working, AC8; `@…` refs are never probed on disk), and a
 * **parity check** against core's `splitBlockRef`: the CLI vendors the regex
 * (no runtime core dependency) and this test is the drift guard.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
// Core is a devDependency — test-only import (D1): the vendored grammar must
// match core's byte for byte.
import { splitBlockRef as coreSplitBlockRef } from '@ion-drive/core';
import { afterAll, describe, expect, it } from 'vitest';
import { RefError, isLocalPath, isUrl, parseRef, splitBlockRef } from './ref.js';

describe('splitBlockRef parity with @ion-drive/core', () => {
  const cases = [
    'crm',
    'crm_2',
    'audit-log',
    '@acme/billing',
    '@a/b',
    '@acme/billing_v2',
    // rejections
    'crm@0.2.0',
    '@ACME/billing',
    '@acme/Billing',
    '@acme/billing/extra',
    'Crm',
    '',
    '@acme/',
    '/billing',
    '@acme',
    '9crm',
    '@9acme/billing',
  ];

  it.each(cases)('agrees with core on %j', (ref) => {
    expect(splitBlockRef(ref)).toEqual(coreSplitBlockRef(ref));
  });
});

describe('parseRef grammar table', () => {
  const accepted: [string, unknown][] = [
    ['crm', { kind: 'registry', namespace: undefined, name: 'crm' }],
    ['crm@0.2.0', { kind: 'registry', namespace: undefined, name: 'crm', selector: '0.2.0' }],
    ['crm@^0.2', { kind: 'registry', namespace: undefined, name: 'crm', selector: '^0.2' }],
    ['crm@>=1 <2', { kind: 'registry', namespace: undefined, name: 'crm', selector: '>=1 <2' }],
    [
      'audit_log@1.x',
      { kind: 'registry', namespace: undefined, name: 'audit_log', selector: '1.x' },
    ],
    ['@acme/billing', { kind: 'registry', namespace: '@acme', name: 'billing' }],
    [
      '@acme/billing@1.x',
      { kind: 'registry', namespace: '@acme', name: 'billing', selector: '1.x' },
    ],
    [
      '@acme/billing@^1.2.0',
      { kind: 'registry', namespace: '@acme', name: 'billing', selector: '^1.2.0' },
    ],
    ['https://x.test/block.json', { kind: 'url', url: 'https://x.test/block.json' }],
    ['http://localhost:8080/block.json', { kind: 'url', url: 'http://localhost:8080/block.json' }],
  ];

  it.each(accepted)('accepts %j', (input, expected) => {
    expect(parseRef(input)).toMatchObject(expected as Record<string, unknown>);
  });

  const rejected = [
    'crm@not a version',
    'crm@',
    '@ACME/billing',
    '@acme/billing@',
    'Crm',
    '@acme', // a namespace alone is not a block ref
    '',
  ];

  it.each(rejected)('rejects %j with a RefError', (input) => {
    expect(() => parseRef(input)).toThrow(RefError);
  });

  it('never treats @-refs as local paths (no disk probe)', () => {
    // Even if a directory named "@acme/billing" existed, the grammar wins.
    expect(parseRef('@acme/billing')).toMatchObject({ kind: 'registry', name: 'billing' });
    expect(isLocalPath('@acme/billing')).toBe(false);
  });
});

describe('local paths (AC8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ion-ref-'));
  const blockDir = join(dir, 'block-crm');
  mkdirSync(blockDir);
  writeFileSync(join(blockDir, 'block.json'), '{"name":"crm"}', 'utf8');

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('classifies a native-separator path with block.json as local', () => {
    // On Windows this is a backslash path — the AC8 re-assertion.
    const nativePath = [dir, 'block-crm'].join(sep);
    expect(parseRef(nativePath)).toEqual({ kind: 'local', path: nativePath });
  });

  it('classifies a forward-slash relative-style path as local too', () => {
    const fwd = blockDir.split(sep).join('/');
    expect(parseRef(fwd)).toEqual({ kind: 'local', path: fwd });
  });

  it('reports a missing block.json for a path-looking ref', () => {
    const missing = [dir, 'nope'].join(sep);
    expect(() => parseRef(missing)).toThrow(/No block\.json found/);
  });
});

describe('isUrl', () => {
  it('matches http(s) and nothing else', () => {
    expect(isUrl('https://x.test/a.json')).toBe(true);
    expect(isUrl('http://localhost/a.json')).toBe(true);
    expect(isUrl('ftp://x.test/a.json')).toBe(false);
    expect(isUrl('crm')).toBe(false);
  });
});
