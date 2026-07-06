/**
 * Unit tests for the framework-project helpers: barrel maintenance (marker
 * insertion/removal, idempotence) and vendored-code writes (never overwrite).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BarrelError,
  EMPTY_BARREL,
  addToBarrel,
  barrelPath,
  hasVendoredCode,
  isProjectDir,
  removeFromBarrel,
  vendorBlockCode,
} from './project.js';

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

  it('silently drops unsafe paths (defense in depth behind manifest validation)', () => {
    const result = vendorBlockCode('x', [{ path: '../escape.ts', contents: 'nope' }], dir);
    expect(result.written).toEqual([]);
  });
});

describe('isProjectDir', () => {
  it('requires server.ts plus a core dependency', () => {
    expect(isProjectDir(dir)).toBe(false);
    writeFileSync(join(dir, 'server.ts'), '// root\n', 'utf8');
    expect(isProjectDir(dir)).toBe(false);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@ionshift/ion-drive-core': '^0.1.0' } }),
      'utf8',
    );
    expect(isProjectDir(dir)).toBe(true);
  });
});
