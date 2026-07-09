/**
 * Unit tests for `ion-drive block validate`'s core-free fallback checks
 * (spec-02): manifest-v1 version/dependencies/requires.core grammar plus the
 * Phase 14 vendored-code presence checks, as a pure function. Also `block
 * pack`'s versioned artifact path (spec-05 D8).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../registry/registry-client.js';
import { packBytes } from '../registry/verify.js';
import { blockPackCommand, structuralManifestChecks } from './block.js';

const base = { name: 'crm', title: 'CRM' } as Manifest;

describe('structuralManifestChecks', () => {
  it('passes a minimal manifest and a fully-specified v1 manifest', () => {
    expect(structuralManifestChecks(base)).toEqual([]);
    expect(
      structuralManifestChecks({
        ...base,
        version: '0.2.0',
        dependencies: { invoicing: '^0.1.0', audit: '*' },
        requires: { core: '>=0.2.0 <1.0.0', handlers: [], plugins: [] },
      } as Manifest),
    ).toEqual([]);
  });

  it.each(['1.0', 'v1.0.0', '1.0.0+build.1'])('rejects non-canonical version %j', (version) => {
    const issues = structuralManifestChecks({ ...base, version } as Manifest);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/version must be a canonical semver version/);
  });

  it('rejects the legacy array dependencies form with a record-form pointer', () => {
    const issues = structuralManifestChecks({
      ...base,
      dependencies: ['crm'],
    } as unknown as Manifest);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/legacy array form.*record/);
  });

  it('rejects an invalid dependency range, naming the dependency', () => {
    const issues = structuralManifestChecks({
      ...base,
      dependencies: { invoicing: 'latest' },
    } as Manifest);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/dependencies\.invoicing must be a valid semver range/);
  });

  it('rejects an invalid requires.core range', () => {
    const issues = structuralManifestChecks({
      ...base,
      requires: { core: 'not-a-range' },
    } as Manifest);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/requires\.core must be a valid semver range/);
  });

  it('still flags declared actions/hooks without vendored code', () => {
    const issues = structuralManifestChecks({
      ...base,
      actions: [{ name: 'ping' }],
    } as Manifest);
    expect(issues).toEqual([
      'The manifest declares actions/hooks but there is no code/ directory (or embedded code) to vendor.',
      'Vendored code must include an index.ts (the plugin entry the barrel imports).',
    ]);
  });
});

describe('blockPackCommand (spec-05 D8: versioned artifact path)', () => {
  it('packs to dist/<version>/block.json with code embedded, byte-identical to packBytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-pack-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const manifest = { name: 'billing', version: '1.2.3', title: 'Billing' };
      writeFileSync(join(dir, 'block.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      mkdirSync(join(dir, 'code'));
      writeFileSync(join(dir, 'code', 'index.ts'), 'export default 1;\n', 'utf8');

      await blockPackCommand(dir);
      expect(process.exitCode).toBeUndefined();
      const artifact = join(dir, 'dist', '1.2.3', 'block.json');
      expect(existsSync(artifact)).toBe(true);
      expect(new Uint8Array(readFileSync(artifact))).toEqual(
        packBytes({ ...manifest, code: [{ path: 'index.ts', contents: 'export default 1;\n' }] }),
      );
      // The legacy mutable path is never written.
      expect(existsSync(join(dir, 'dist', 'block.json'))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
      process.exitCode = undefined;
    }
  });

  it('refuses to pack without a canonical semver version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-pack-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(
        join(dir, 'block.json'),
        `${JSON.stringify({ name: 'billing', version: 'v1', title: 'Billing' }, null, 2)}\n`,
        'utf8',
      );
      await blockPackCommand(dir);
      expect(process.exitCode).toBe(1);
      expect(existsSync(join(dir, 'dist'))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
      process.exitCode = undefined;
    }
  });
});

describe('blockNewCommand (spec-06 §2: the regenerated scaffold)', () => {
  it('writes the full SDLC file set with version-derived presets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-block-new-'));
    const previousCwd = process.cwd();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(dir);
      const { blockNewCommand } = await import('./block.js');
      await blockNewCommand('billing');
      expect(process.exitCode).toBeUndefined();

      const root = join(dir, 'block-billing');
      for (const path of [
        'block.json',
        'code/index.ts',
        'test/fixtures.json',
        'test/smoke.test.ts',
        'README.md',
        '.github/workflows/ci.yml',
        '.github/workflows/publish.yml',
        '.gitignore',
        '.gitattributes',
      ]) {
        expect(existsSync(join(root, path)), path).toBe(true);
      }

      const manifest = JSON.parse(readFileSync(join(root, 'block.json'), 'utf8')) as {
        name: string;
        version: string;
        requires: { core: string };
      };
      expect(manifest.name).toBe('billing');
      expect(manifest.version).toBe('0.1.0');
      // requires.core preset derives from the CLI's own major.minor.
      expect(manifest.requires.core).toMatch(/^>=\d+\.\d+\.0 <1\.0\.0$/);

      const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
      expect(ci).toContain('postgres:17');
      expect(ci).toMatch(/npm install -g @ion-drive\/cli@\^\d+\.\d+ @ion-drive\/core@\^\d+\.\d+/);
      expect(ci).toContain('ion-drive block validate .');
      expect(ci).toContain('ion-drive block pack .');
      expect(ci).toContain('ion-drive block test . --json');
      expect(ci).toContain('--database-url postgresql://postgres:postgres@localhost:5432/postgres');
      expect(ci).toContain("git diff --exit-code -- 'dist/'");

      const publish = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');
      expect(publish).toContain(
        'jaredgrabill/ion-drive-blocks/.github/workflows/publish-block.yml@v1',
      );
      expect(publish).toContain('ion-drive block publish --registry-repo');
      expect(publish).toContain('default: true'); // dispatch dry-run default

      const gitattributes = readFileSync(join(root, '.gitattributes'), 'utf8');
      expect(gitattributes).toContain('dist/** -text');
      expect(gitattributes).toContain('*.sigstore.json -text');

      const smoke = readFileSync(join(root, 'test/smoke.test.ts'), 'utf8');
      expect(smoke).toContain('ION_TEST_SERVER_URL');
      expect(smoke).toContain('ION_TEST_API_KEY');
      expect(smoke).toContain('billing_items');
      expect(readFileSync(join(root, 'test/fixtures.json'), 'utf8')).toContain('"seedChecks"');
    } finally {
      process.chdir(previousCwd);
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
      process.exitCode = undefined;
    }
  });
});
