/**
 * Writes the registry protocol v1 JSON Schema files (spec-01 §8) to
 * `packages/core/schemas/`. Run via `pnpm --filter @ion-drive/core
 * emit:schemas` whenever the Zod schemas in `registry-types.ts` change; a
 * unit test (`registry-types.test.ts`) fails on drift.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRegistryJsonSchemas } from '../src/blocks/registry-json-schemas.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
mkdirSync(outDir, { recursive: true });

for (const [basename, text] of Object.entries(renderRegistryJsonSchemas())) {
  writeFileSync(join(outDir, basename), text, 'utf8');
  console.log(`wrote schemas/${basename}`);
}
