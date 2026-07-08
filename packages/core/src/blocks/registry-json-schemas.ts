/**
 * Registry protocol v1 — published JSON Schema rendering (ADR-022 / spec-01 §8).
 *
 * Generates the three JSON Schema documents published at
 * `https://ion-drive.dev/schemas/*.v1.json` from the Zod schemas in
 * `registry-types.ts`, so the wire format has exactly one source of truth.
 * The committed files under `packages/core/schemas/` are written by
 * `scripts/emit-json-schemas.ts` (`pnpm --filter @ion-drive/core emit:schemas`)
 * and drift-guarded by a unit test that re-renders and byte-compares.
 *
 * Deliberately NOT exported from the package barrel — it exists for the emit
 * script and the drift test, not for consumers (they get the Zod schemas).
 */

import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  registriesDirectorySchema,
  registryBlockSchema,
  registryIndexSchema,
} from './registry-types.js';

/** Where the schemas are published once spec-05's Pages setup serves them. */
const SCHEMA_ID_BASE = 'https://ion-drive.dev/schemas/';

/** Basename → Zod source for each published schema document. */
const SCHEMA_SOURCES: Record<string, z.ZodTypeAny> = {
  'registry-index.v1.json': registryIndexSchema,
  'registry-block.v1.json': registryBlockSchema,
  'registries-directory.v1.json': registriesDirectorySchema,
};

/**
 * Renders each published schema basename to its exact file text
 * (deterministic — same input Zod, same output bytes).
 *
 * `zod-to-json-schema` emits draft-07-shaped output, but every construct it
 * produces for our shapes (`type`/`properties`/`required`/`const`/`enum`/
 * `pattern`/`format`/`additionalProperties`) is syntactically identical in
 * draft 2020-12, so stamping the 2020-12 `$schema` is valid.
 */
export function renderRegistryJsonSchemas(): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [basename, zodSchema] of Object.entries(SCHEMA_SOURCES)) {
    const { $schema: _dropped, ...body } = zodToJsonSchema(zodSchema, {
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    const doc = {
      $id: `${SCHEMA_ID_BASE}${basename}`,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      ...body,
    };
    rendered[basename] = `${JSON.stringify(doc, null, 2)}\n`;
  }
  return rendered;
}
