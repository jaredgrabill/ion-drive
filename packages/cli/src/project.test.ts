/**
 * Unit tests for the framework-project helpers: barrel maintenance (marker
 * insertion/removal, idempotence) and vendored-code writes (never overwrite),
 * plus the spec-04 §5 vendoring-path hardening (VendorError, caps, and the
 * shared attack-vector list).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BarrelError,
  EMPTY_BARREL,
  VendorError,
  addToBarrel,
  barrelPath,
  hasVendoredCode,
  isProjectDir,
  removeFromBarrel,
  vendorBlockCode,
} from './project.js';

/**
 * The shared vendoring-path attack vectors (spec-04 AC6).
 * KEEP IN SYNC with core's list in
 * `packages/core/src/blocks/block-types.test.ts` — the CLI's vendoring and
 * core's manifest schema must reject these identically.
 */
const PATH_ATTACK_VECTORS = [
  '../x',
  '..\\x',
  '/x',
  'C:\\x',
  'C:x',
  '\\\\srv\\x',
  'a/../../x',
  'a\\..\\..',
  'a//b',
  './a',
  'a/./b',
  `${'a'.repeat(200)}b`, // 201 chars
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-cli-project-'));
  mkdirSync(join(dir, 'blocks'), { recursive: true });
  writeFileSync(barrelPath(dir), EMPTY_BARREL, 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('barrel maintenance', () => {
  it('adds an import + entry and is idempotent', () => {
    expect(addToBarrel('invoicing', dir)).toBe(true);
    expect(addToBarrel('invoicing', dir)).toBe(false); // second run: no change

    const barrel = readFileSync(barrelPath(dir), 'utf8');
    expect(barrel).toContain("import invoicing from './invoicing/index.js';");
    expect(barrel).toContain('  invoicing,');
  });

  it('sanitizes kebab-case names into identifiers', () => {
    addToBarrel('stripe-billing', dir);
    const barrel = readFileSync(barrelPath(dir), 'utf8');
    expect(barrel).toContain("import stripe_billing from './stripe-billing/index.js';");
  });

  it('removes exactly the block entries it added', () => {
    addToBarrel('crm', dir);
    addToBarrel('invoicing', dir);
    expect(removeFromBarrel('crm', dir)).toBe(true);
    expect(removeFromBarrel('crm', dir)).toBe(false);

    const barrel = readFileSync(barrelPath(dir), 'utf8');
    expect(barrel).not.toContain('crm');
    expect(barrel).toContain("import invoicing from './invoicing/index.js';");
  });

  it('throws a BarrelError when the barrel or markers are missing', () => {
    rmSync(barrelPath(dir));
    expect(() => addToBarrel('crm', dir)).toThrow(BarrelError);

    writeFileSync(barrelPath(dir), 'export const blocks = [];\n', 'utf8');
    expect(() => addToBarrel('crm', dir)).toThrow(/markers/);
  });
});

describe('vendorBlockCode', () => {
  const files = [
    { path: 'index.ts', contents: 'export default 1;\n' },
    { path: 'lib/stripe.ts', contents: 'export const x = 1;\n' },
  ];

  it('writes files (including nested paths) and reports them', () => {
    const result = vendorBlockCode('invoicing', files, dir);
    expect(result.written).toEqual(['blocks/invoicing/index.ts', 'blocks/invoicing/lib/stripe.ts']);
    expect(hasVendoredCode('invoicing', dir)).toBe(true);
  });

  it('never overwrites existing files — user edits win', () => {
    vendorBlockCode('invoicing', files, dir);
    writeFileSync(join(dir, 'blocks', 'invoicing', 'index.ts'), '// my edit\n', 'utf8');

    const rerun = vendorBlockCode('invoicing', files, dir);
    expect(rerun.written).toEqual([]);
    expect(rerun.skipped).toContain('blocks/invoicing/index.ts');
    expect(readFileSync(join(dir, 'blocks', 'invoicing', 'index.ts'), 'utf8')).toBe('// my edit\n');
  });

  it.each(PATH_ATTACK_VECTORS)('throws VendorError for unsafe path %s (AC6)', (attack) => {
    expect(() => vendorBlockCode('x', [{ path: attack, contents: 'nope' }], dir)).toThrow(
      VendorError,
    );
  });

  it('writes NOTHING when any path is unsafe — even the safe ones (AC1/AC6)', () => {
    const mixed = [
      { path: 'index.ts', contents: 'safe' },
      { path: '../escape.ts', contents: 'nope' },
    ];
    expect(() => vendorBlockCode('x', mixed, dir)).toThrow(/\.\.\/escape\.ts/);
    // The block folder must not exist at all — validation ran before writes.
    expect(existsSync(join(dir, 'blocks', 'x'))).toBe(false);
    expect(readdirSync(join(dir, 'blocks'))).toEqual(['index.ts']); // the barrel only
  });

  it('rejects more than 500 files before writing anything', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      path: `f${i}.ts`,
      contents: 'x',
    }));
    expect(() => vendorBlockCode('x', many, dir)).toThrow(/501 code files/);
    expect(existsSync(join(dir, 'blocks', 'x'))).toBe(false);
  });

  it('rejects more than 5 MB of total embedded code', () => {
    const big = Array.from({ length: 11 }, (_, i) => ({
      path: `f${i}.ts`,
      contents: 'x'.repeat(500_000), // 11 × 500 KB = 5.5 MB, each under 512 KB
    }));
    expect(() => vendorBlockCode('x', big, dir)).toThrow(/bytes of code/);
    expect(existsSync(join(dir, 'blocks', 'x'))).toBe(false);
  });

  it('the resolve-boundary belt holds even for paths passing the segment rules', () => {
    // No current vector passes the rules but escapes resolve(); this pins the
    // belt's behavior on a plain-safe path (resolves inside → no throw).
    const result = vendorBlockCode('x', [{ path: 'nested/deep/file.ts', contents: 'ok' }], dir);
    expect(result.written).toEqual(['blocks/x/nested/deep/file.ts']);
  });
});

describe('isProjectDir', () => {
  it('requires server.ts plus a core dependency', () => {
    expect(isProjectDir(dir)).toBe(false);
    writeFileSync(join(dir, 'server.ts'), '// root\n', 'utf8');
    expect(isProjectDir(dir)).toBe(false);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@ion-drive/core': '^0.1.0' } }),
      'utf8',
    );
    expect(isProjectDir(dir)).toBe(true);
  });
});
