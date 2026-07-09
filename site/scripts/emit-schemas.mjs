/**
 * Canonical JSON Schema emission (spec-10 AC5) — copies
 * `packages/core/schemas/*.v1.json` into the site build output **raw-byte**
 * (Buffer copy, never parse/re-serialize), so `iondrive.dev/schemas/*` is
 * byte-identical to the files core publishes to npm. Nothing is committed
 * under `site/public/` — the Astro integration in
 * `src/integrations/emit-schemas.ts` calls this at `astro:build:done` and
 * serves the same files in dev.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Copies every `*.v1.json` schema from `srcDir` to `outDir` as raw bytes.
 * @param {string} srcDir - `packages/core/schemas`
 * @param {string} outDir - e.g. `site/dist/schemas`
 * @returns {{ files: string[] }} the copied file names
 */
export function emitSchemas(srcDir, outDir) {
  if (!existsSync(srcDir)) throw new Error(`schemas source directory not found: ${srcDir}`);
  const files = readdirSync(srcDir)
    .filter((name) => name.endsWith('.v1.json'))
    .sort();
  if (files.length === 0) throw new Error(`no *.v1.json schemas found in ${srcDir}`);
  mkdirSync(outDir, { recursive: true });
  for (const name of files) {
    // copyFileSync is a byte copy — no JSON parse, no re-serialization.
    copyFileSync(path.join(srcDir, name), path.join(outDir, name));
  }
  return { files };
}

/** The canonical source directory, resolved from this script's location. */
export function defaultSchemasDir() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, '../../packages/core/schemas');
}

// --- CLI entry ---------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outDir = process.argv[2] ?? path.resolve(scriptDir, '../dist/schemas');
  const { files } = emitSchemas(defaultSchemasDir(), outDir);
  console.log(`emit-schemas: copied ${files.length} schemas into ${outDir}`);
}
