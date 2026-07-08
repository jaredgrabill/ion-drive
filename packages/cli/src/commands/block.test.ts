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
