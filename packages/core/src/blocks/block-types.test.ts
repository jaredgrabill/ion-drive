/**
 * Unit tests for the spec-04 pieces of block-types: the install-source
 * envelope schema (strict — unknown keys rejected), `codePathIssue` +
 * `codeFileSchema` path hardening against the shared attack-vector list, and
 * the `code[]` file-count / total-size caps.
 */

import { describe, expect, it } from 'vitest';
import { parseManifest } from './block-manifest.js';
import { codePathIssue, installSourceSchema } from './block-types.js';

/**
 * The shared vendoring-path attack vectors (spec-04 AC6).
 * KEEP IN SYNC with the CLI's list in `packages/cli/src/project.test.ts` —
 * core's manifest schema and the CLI's vendoring must reject these
 * identically.
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

describe('installSourceSchema', () => {
  const specExample = {
    registry: '@ion',
    url: 'https://registry.iondrive.dev/crm/dist/0.2.0/block.json',
    digest: `sha256:${'ab12'.repeat(16)}`,
    attested: true,
    publisher: 'github.com/jaredgrabill/ion-drive-blocks',
    tier: 'official',
  };

  it('accepts the spec example envelope', () => {
    expect(installSourceSchema.parse(specExample)).toEqual(specExample);
  });

  it('accepts an empty object (every field optional)', () => {
    expect(installSourceSchema.parse({})).toEqual({});
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => installSourceSchema.parse({ ...specExample, extra: 1 })).toThrow();
  });

  it('rejects a malformed digest', () => {
    expect(() => installSourceSchema.parse({ digest: 'sha256:short' })).toThrow();
    expect(() => installSourceSchema.parse({ digest: `md5:${'a'.repeat(64)}` })).toThrow();
    expect(() => installSourceSchema.parse({ digest: `sha256:${'A'.repeat(64)}` })).toThrow(); // hex is lowercase
  });

  it('rejects an unknown tier', () => {
    expect(() => installSourceSchema.parse({ tier: 'platinum' })).toThrow();
  });

  it('rejects a non-URL url', () => {
    expect(() => installSourceSchema.parse({ url: 'not a url' })).toThrow();
  });
});

describe('codePathIssue (spec-04 §5)', () => {
  it.each(PATH_ATTACK_VECTORS)('rejects %s (AC6)', (attack) => {
    expect(codePathIssue(attack)).not.toBeNull();
  });

  it.each(['index.ts', 'lib/stripe.ts', 'a/b/c.d.ts', 'a'.repeat(200)])('accepts %s', (path) => {
    expect(codePathIssue(path)).toBeNull();
  });
});

describe('manifest code[] hardening', () => {
  const base = {
    name: 'hardened',
    title: 'Hardened',
    objects: [
      {
        name: 'things',
        displayName: 'Things',
        fields: [{ name: 'label', displayName: 'Label', columnType: 'text' }],
      },
    ],
  };

  it.each(PATH_ATTACK_VECTORS)('the manifest schema rejects code path %s (AC6)', (attack) => {
    expect(() => parseManifest({ ...base, code: [{ path: attack, contents: 'x' }] })).toThrow();
  });

  it('rejects more than 500 code files', () => {
    const code = Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.ts`, contents: 'x' }));
    expect(() => parseManifest({ ...base, code })).toThrow(/max 500/);
  });

  it('rejects more than 5 MB of total embedded code', () => {
    // 11 × 500 KB = 5.5 MB, each file under the 512 KB per-file cap.
    const code = Array.from({ length: 11 }, (_, i) => ({
      path: `f${i}.ts`,
      contents: 'x'.repeat(500_000),
    }));
    expect(() => parseManifest({ ...base, code })).toThrow(/in total/);
  });

  it('still accepts a normal vendored-code manifest', () => {
    const m = parseManifest({ ...base, code: [{ path: 'index.ts', contents: 'export {}' }] });
    expect(m.code).toHaveLength(1);
  });
});
