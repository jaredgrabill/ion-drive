/**
 * Emits the distributable `blocks/<name>/block.json` artifacts from the typed
 * manifests in `src/blocks/*`. TypeScript is the source of truth (so column
 * types and shapes are compiler-checked); this script writes the JSON form that
 * ships in the package and can be inspected/copied shadcn-style.
 *
 * Run with: `pnpm --filter @ionshift/ion-drive-blocks emit`
 * A test (`manifests.test.ts`) asserts the committed JSON matches the source, so
 * drift fails CI.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockRegistry } from '../src/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const blocksDir = join(here, '..', 'blocks');

for (const manifest of blockRegistry) {
  const dir = join(blocksDir, manifest.name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'block.json');
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`✔ wrote ${file}`);
}

console.log(`\nEmitted ${blockRegistry.length} block manifest(s).`);
