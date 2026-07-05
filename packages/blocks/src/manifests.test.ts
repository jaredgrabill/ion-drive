/**
 * Guards the bundled block catalog:
 *  1. every manifest validates through core's authoritative parser, and
 *  2. the committed `block.json` artifacts match their TypeScript source (no drift).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '@ionshift/ion-drive-core';
import { describe, expect, it } from 'vitest';
import { blockRegistry } from './registry.js';

const blocksDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'blocks');

describe('bundled block catalog', () => {
  for (const manifest of blockRegistry) {
    describe(manifest.name, () => {
      it('validates through core.parseManifest', () => {
        expect(() => parseManifest(manifest)).not.toThrow();
      });

      it('has a committed block.json matching the TypeScript source', () => {
        const json = JSON.parse(readFileSync(join(blocksDir, manifest.name, 'block.json'), 'utf8'));
        expect(json).toEqual(manifest);
      });
    });
  }

  it('invoicing declares its crm dependency', () => {
    const invoicing = blockRegistry.find((b) => b.name === 'invoicing');
    expect(invoicing?.dependencies).toContain('crm');
  });
});
