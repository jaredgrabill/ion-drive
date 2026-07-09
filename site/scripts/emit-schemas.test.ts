/**
 * Schema emission tests (spec-10 AC5): the emitted files must be BYTE
 * identical to `packages/core/schemas/*.v1.json` (Buffer.equals — no JSON
 * round-trip may ever slip in), and the emitted set must be exactly the
 * source's `*.v1.json` set.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSchemasDir, emitSchemas } from './emit-schemas.mjs';

describe('emitSchemas', () => {
  let out: string;
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it('emits every *.v1.json schema byte-identically', () => {
    out = mkdtempSync(path.join(tmpdir(), 'emit-schemas-'));
    const srcDir = defaultSchemasDir();
    const { files } = emitSchemas(srcDir, out);

    const expected = readdirSync(srcDir)
      .filter((name) => name.endsWith('.v1.json'))
      .sort();
    expect(files).toEqual(expected);
    expect(files.length).toBeGreaterThan(0);
    expect(readdirSync(out).sort()).toEqual(expected);

    for (const name of files) {
      const src = readFileSync(path.join(srcDir, name));
      const emitted = readFileSync(path.join(out, name));
      expect(emitted.equals(src), `${name} must be byte-identical`).toBe(true);
    }
  });

  it('names the canonical schemas the registry protocol depends on', () => {
    out = mkdtempSync(path.join(tmpdir(), 'emit-schemas-'));
    const { files } = emitSchemas(defaultSchemasDir(), out);
    expect(files).toContain('registry-index.v1.json');
    expect(files).toContain('registry-block.v1.json');
    expect(files).toContain('registries-directory.v1.json');
    expect(files).toContain('block-manifest.v1.json');
  });
});
