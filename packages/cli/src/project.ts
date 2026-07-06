/**
 * Framework-project helpers (Phase 14, ADR-018).
 *
 * A *scaffolded project* is a user-owned repo created by `ion-drive init`: a
 * `server.ts` composition root, a `/blocks` directory of vendored block code,
 * and `@ionshift/ion-drive-core` in its dependencies. This module holds the
 * pieces `init`/`add`/`remove`/`dev` share:
 *
 *  - project detection (`isProjectDir`) — how `dev` decides between running the
 *    user's `server.ts` and the monorepo contributor path;
 *  - the **blocks barrel** (`blocks/index.ts`) — an explicit, greppable list of
 *    vendored block plugins that `server.ts` passes to `createServer`. The CLI
 *    maintains it between marker comments on `add`/`remove`; no runtime fs
 *    scanning, per ADR-018's explicit-over-magic rule;
 *  - vendored-code writes (`vendorBlockCode`) — copy a block's `code` files to
 *    `blocks/<name>/`, skipping anything that exists (shadcn semantics: the
 *    user owns the copy; the CLI never overwrites or deletes their code).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Marker lines the barrel maintains its entries between. */
const IMPORTS_MARKER = '// ion-drive:imports';
const BLOCKS_MARKER = '// ion-drive:blocks';

/** The initial barrel written by `init` — empty but marker-complete. */
export const EMPTY_BARREL = `/**
 * Vendored building blocks — maintained by \`ion-drive add/remove\`.
 *
 * Each entry is a block's plugin (its \`blocks/<name>/index.ts\` default
 * export). \`server.ts\` passes this list to \`createServer\`, which loads each
 * plugin so its actions/hooks register before the server starts. The list is
 * deliberately explicit — greppable and agent-legible, no directory scanning.
 */
import type { IonPlugin } from '@ionshift/ion-drive-core';
${IMPORTS_MARKER}

export const blocks: IonPlugin[] = [
  ${BLOCKS_MARKER}
];
`;

/** True when `dir` looks like a scaffolded framework project. */
export function isProjectDir(dir = process.cwd()): boolean {
  const root = resolve(dir);
  if (!existsSync(join(root, 'server.ts'))) return false;
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.['@ionshift/ion-drive-core'] ??
        pkg.devDependencies?.['@ionshift/ion-drive-core'],
    );
  } catch {
    return false;
  }
}

export function barrelPath(dir = process.cwd()): string {
  return join(resolve(dir), 'blocks', 'index.ts');
}

/** Reads the barrel, returning null when the project has none. */
function readBarrel(dir: string): string | null {
  const path = barrelPath(dir);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export class BarrelError extends Error {}

/**
 * Adds a block's import + list entry to the barrel (idempotent). Returns true
 * when the barrel changed. Throws {@link BarrelError} when the barrel or its
 * markers are missing — the user has taken ownership of the file shape.
 */
export function addToBarrel(blockName: string, dir = process.cwd()): boolean {
  const source = readBarrel(dir);
  if (source === null) {
    throw new BarrelError(
      `No blocks barrel at ${barrelPath(dir)} — is this an ion-drive project? (run "ion-drive init")`,
    );
  }
  if (!source.includes(IMPORTS_MARKER) || !source.includes(BLOCKS_MARKER)) {
    throw new BarrelError(
      `blocks/index.ts is missing the "${IMPORTS_MARKER}" / "${BLOCKS_MARKER}" markers — add the import for "${blockName}" manually.`,
    );
  }
  const varName = importName(blockName);
  if (source.includes(`from './${blockName}/index.js'`)) return false; // already wired

  const updated = source
    .replace(IMPORTS_MARKER, `${IMPORTS_MARKER}\nimport ${varName} from './${blockName}/index.js';`)
    .replace(BLOCKS_MARKER, `${BLOCKS_MARKER}\n  ${varName},`);
  writeFileSync(barrelPath(dir), updated, 'utf8');
  return true;
}

/**
 * Removes a block's entries from the barrel (line-based, so user formatting
 * elsewhere survives). Returns true when something was removed.
 */
export function removeFromBarrel(blockName: string, dir = process.cwd()): boolean {
  const source = readBarrel(dir);
  if (source === null) return false;
  const varName = importName(blockName);
  const lines = source.split('\n');
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed !== `import ${varName} from './${blockName}/index.js';` && trimmed !== `${varName},`
    );
  });
  if (kept.length === lines.length) return false;
  writeFileSync(barrelPath(dir), kept.join('\n'), 'utf8');
  return true;
}

/** A block name as a valid TS identifier (`stripe-billing` → `stripe_billing`). */
function importName(blockName: string): string {
  return blockName.replace(/[^a-zA-Z0-9_$]/g, '_');
}

export interface VendorResult {
  /** Files written (project-relative paths). */
  written: string[];
  /** Files skipped because they already exist (never overwritten). */
  skipped: string[];
}

/**
 * Copies a block's code files into `blocks/<name>/`. Existing files are always
 * skipped and reported — re-running `add` never clobbers user edits.
 */
export function vendorBlockCode(
  blockName: string,
  files: { path: string; contents: string }[],
  dir = process.cwd(),
): VendorResult {
  const blockRoot = join(resolve(dir), 'blocks', blockName);
  const result: VendorResult = { written: [], skipped: [] };
  for (const file of files) {
    // Manifest validation already rejects absolute/`..` paths; re-check cheaply.
    if (file.path.startsWith('/') || file.path.includes('..')) continue;
    const target = join(blockRoot, file.path);
    const relative = `blocks/${blockName}/${file.path}`;
    if (existsSync(target)) {
      result.skipped.push(relative);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, 'utf8');
    result.written.push(relative);
  }
  return result;
}

/** True when the project has a vendored folder for this block. */
export function hasVendoredCode(blockName: string, dir = process.cwd()): boolean {
  return existsSync(join(resolve(dir), 'blocks', blockName));
}
