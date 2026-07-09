/**
 * Framework-project helpers (Phase 14, ADR-018).
 *
 * A *scaffolded project* is a user-owned repo created by `ion-drive init`: a
 * `server.ts` composition root, a `/blocks` directory of vendored block code,
 * and `@ion-drive/core` in its dependencies. This module holds the
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
import { dirname, join, resolve, sep } from 'node:path';

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
import type { IonPlugin } from '@ion-drive/core';
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
      pkg.dependencies?.['@ion-drive/core'] ?? pkg.devDependencies?.['@ion-drive/core'],
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

/** Thrown when a block's code files fail the vendoring-path hardening. */
export class VendorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorError';
  }
}

/** Caps mirroring core's manifest schema (spec-04 §5): bound files + memory. */
const MAX_CODE_FILES = 500;
const MAX_TOTAL_CODE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Rejects a vendored code path that could escape `blocks/<name>/`.
 * Returns the human-readable problem, or null when safe.
 *
 * KEEP IN SYNC with core's `codePathIssue` in
 * `packages/core/src/blocks/block-types.ts` — same rules, deliberately
 * duplicated so the CLI needs no runtime core dependency (the `ref.ts`
 * vendored-copy precedent). Order matters: normalize backslashes FIRST, then
 * validate the normalized form (never validate-then-normalize).
 */
function vendorPathIssue(path: string): string | null {
  if (path.length < 1 || path.length > 200) return 'must be 1–200 characters';
  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized)) return 'must not be a Windows drive path';
  if (normalized.startsWith('//')) return 'must not be a UNC path';
  if (normalized.startsWith('/')) return 'must be relative (no leading /)';
  for (const segment of normalized.split('/')) {
    if (segment === '') return 'must not contain empty path segments';
    if (segment === '.') return 'must not contain "." segments';
    if (segment === '..') return 'must not contain ".." segments';
  }
  return null;
}

/**
 * Copies a block's code files into `blocks/<name>/`. Existing files are always
 * skipped and reported — re-running `add` never clobbers user edits.
 *
 * Defense in depth (spec-04 §5): every path is validated **before anything is
 * written** (a malicious artifact must not plant even one file outside the
 * block folder), the file-count/total-size caps bound memory, and the
 * resolved target is asserted to sit strictly inside the block directory —
 * the belt after the suspenders.
 * @throws {VendorError} naming the offending path or exceeded cap
 */
export function vendorBlockCode(
  blockName: string,
  files: { path: string; contents: string }[],
  dir = process.cwd(),
): VendorResult {
  const blockRoot = resolve(dir, 'blocks', blockName);
  assertVendorable(blockName, files, blockRoot);

  const result: VendorResult = { written: [], skipped: [] };
  for (const file of files) {
    const target = resolve(blockRoot, file.path.replace(/\\/g, '/'));
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

/** Validates all files up front so a bad artifact writes nothing at all. */
function assertVendorable(
  blockName: string,
  files: { path: string; contents: string }[],
  blockRoot: string,
): void {
  if (files.length > MAX_CODE_FILES) {
    throw new VendorError(
      `Block "${blockName}" ships ${files.length} code files (max ${MAX_CODE_FILES}) — refusing to vendor.`,
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    const issue = vendorPathIssue(file.path);
    if (issue) {
      throw new VendorError(
        `Block "${blockName}" declares an unsafe code path ${JSON.stringify(file.path)}: ${issue}. Nothing was vendored.`,
      );
    }
    // Belt after the suspenders: the resolved target must sit inside blockRoot.
    const target = resolve(blockRoot, file.path.replace(/\\/g, '/'));
    if (!target.startsWith(blockRoot + sep)) {
      throw new VendorError(
        `Block "${blockName}" code path ${JSON.stringify(file.path)} resolves outside blocks/${blockName}/. Nothing was vendored.`,
      );
    }
    totalBytes += Buffer.byteLength(file.contents, 'utf8');
  }
  if (totalBytes > MAX_TOTAL_CODE_BYTES) {
    throw new VendorError(
      `Block "${blockName}" embeds ${totalBytes} bytes of code (max ${MAX_TOTAL_CODE_BYTES}) — refusing to vendor.`,
    );
  }
}

/** True when the project has a vendored folder for this block. */
export function hasVendoredCode(blockName: string, dir = process.cwd()): boolean {
  return existsSync(join(resolve(dir), 'blocks', blockName));
}

// ---------------------------------------------------------------------------
// Code updates (spec-07 — the `.new`-file convention)
// ---------------------------------------------------------------------------

/**
 * The six per-file verdicts of the three-way code comparison (spec-07 §2):
 * ledger snapshot (old) × new artifact × the user's tree, all byte-compared.
 */
export type CodeFileStatus =
  | 'unchanged'
  | 'update-available'
  | 'modified-by-you'
  | 'added-upstream'
  | 'removed-upstream'
  | 'yours';

/** One path's verdict plus the bytes the renderers/appliers need. */
export interface CodeFileDelta {
  path: string;
  status: CodeFileStatus;
  /** The pristine ledger-snapshot contents (when the old version shipped it). */
  oldContents?: string;
  /** The new artifact's contents (when the new version ships it). */
  newContents?: string;
}

/** What {@link applyCodeUpdates} did, path by path (project-relative). */
export interface ApplyCodeResult {
  /** Safe overwrites + new files written. */
  written: string[];
  /** `<file>.new` companions written beside user-modified files. */
  newFiles: string[];
  /** Upstream removed these — reported, never deleted. */
  removedUpstream: string[];
}

/**
 * Applies a code-status list to `blocks/<name>/` under the ADR-018 ownership
 * contract: `update-available`/`added-upstream` files are written (the user
 * never touched them / they are new), `modified-by-you` files get the new
 * contents written **adjacent as `<file>.new`** (stale `.new` overwritten;
 * never the user's file), `removed-upstream` is reported for manual deletion,
 * `yours`/`unchanged` are untouched.
 *
 * Path hardening runs on EVERY path — including ones derived from the ledger
 * snapshot: the server's JSON is not trusted to stay inside the block folder
 * (same vendorPathIssue + resolved-inside-blockRoot belt as `vendorBlockCode`).
 * @throws {VendorError} naming the offending path; nothing is written then
 */
export function applyCodeUpdates(
  blockName: string,
  deltas: CodeFileDelta[],
  dir = process.cwd(),
): ApplyCodeResult {
  const blockRoot = resolve(dir, 'blocks', blockName);
  // Validate everything up front so a poisoned list writes nothing at all.
  for (const delta of deltas) assertUpdatablePath(blockName, blockRoot, delta.path);

  const result: ApplyCodeResult = { written: [], newFiles: [], removedUpstream: [] };
  for (const delta of deltas) applyOneCodeDelta(blockName, blockRoot, delta, result);
  return result;
}

/** The vendorBlockCode hardening, applied to one update path. */
function assertUpdatablePath(blockName: string, blockRoot: string, path: string): void {
  const issue = vendorPathIssue(path);
  if (issue) {
    throw new VendorError(
      `Block "${blockName}" update names an unsafe code path ${JSON.stringify(path)}: ${issue}. Nothing was written.`,
    );
  }
  const target = resolve(blockRoot, path.replace(/\\/g, '/'));
  if (!target.startsWith(blockRoot + sep)) {
    throw new VendorError(
      `Block "${blockName}" update path ${JSON.stringify(path)} resolves outside blocks/${blockName}/. Nothing was written.`,
    );
  }
}

/** Applies one file's verdict (write / `.new` beside / report / leave). */
function applyOneCodeDelta(
  blockName: string,
  blockRoot: string,
  delta: CodeFileDelta,
  result: ApplyCodeResult,
): void {
  const relative = `blocks/${blockName}/${delta.path}`;
  const target = resolve(blockRoot, delta.path.replace(/\\/g, '/'));
  if (delta.status === 'update-available' || delta.status === 'added-upstream') {
    if (delta.newContents === undefined) return; // defensive — cannot happen
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, delta.newContents, 'utf8');
    result.written.push(relative);
  } else if (delta.status === 'modified-by-you') {
    if (delta.newContents === undefined) return;
    // The user's file is never touched; the update lands beside it, loud in
    // git status (deliberately NOT gitignored) until they merge + delete it.
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(`${target}.new`, delta.newContents, 'utf8');
    result.newFiles.push(`${relative}.new`);
  } else if (delta.status === 'removed-upstream') {
    result.removedUpstream.push(relative);
  }
}
