/**
 * `ion-drive registry build` — the registry-JSON generator (spec-05 §1).
 *
 * The single source of protocol-v1 registry generation, shadcn's `build`
 * analog. Given a registry repo laid out as `<name>/block.json` (+ `code/`)
 * directories plus a `registry/` output dir, it:
 *
 *  1. **Discovers** blocks by scanning `<name>/block.json` one level deep
 *     (never a hardcoded list — the bug class that made the old CI skip
 *     `catalog`).
 *  2. **Validates** every manifest with core's strict Zod parser — core is
 *     MANDATORY here (unlike `block validate`): a generator that can't run the
 *     strict parsers refuses rather than emit unchecked JSON.
 *  3. **Packs** any manifest version with no `dist/<version>/block.json` yet,
 *     byte-identical to `ion-drive block pack` (both render via `packBytes`).
 *  4. **Regenerates** `registry/blocks/<name>.json` append-only: existing
 *     version entries are preserved verbatim and guarded — any mutation of a
 *     released artifact or version entry is a named refusal. The ONE legal
 *     mutation is `attestationUrl` absent → present, set iff the sigstore
 *     bundle exists on disk beside the artifact (spec-05 §3 ordering / D5).
 *  5. **Regenerates** `registry/index.json` from the per-block docs.
 *
 * Everything is pure over an injected {@link BuildFs} + clock + validator so
 * the whole generator is unit-testable in memory. Writes are buffered and
 * flushed only when there are no refusals; `--check` (CI drift guard) never
 * writes and reports the files that *would* change.
 *
 * Also here: {@link applyStatusEdit}, the `registry yank`/`deprecate` writer
 * (the git-registry admin loop for the mutable status fields).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import semver from 'semver';
import type { CoreValidatorModule } from './core-loader.js';
import { computeDigest, packBytes } from './verify.js';

// ---------------------------------------------------------------------------
// Injectable filesystem
// ---------------------------------------------------------------------------

/** The filesystem slice the generator needs — injected so tests run in memory. */
export interface BuildFs {
  /** Entry names (files + directories) of `dir`. */
  readdir(dir: string): string[];
  /** Raw bytes of a file. Throws when absent. */
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  exists(path: string): boolean;
  stat(path: string): { isDirectory: boolean };
  /** Recursive mkdir. */
  mkdir(dir: string): void;
}

/** The real `node:fs`-backed {@link BuildFs} used by the commands. */
export function realBuildFs(): BuildFs {
  return {
    readdir: (dir) => readdirSync(dir),
    readFile: (path) => new Uint8Array(readFileSync(path)),
    writeFile: (path, data) => writeFileSync(path, data),
    exists: (path) => existsSync(path),
    stat: (path) => ({ isDirectory: statSync(path).isDirectory() }),
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
  };
}

/** Joins path segments with `/` — BuildFs paths are always slash-separated. */
function joinPath(...segments: string[]): string {
  return segments.join('/');
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readText(fs: BuildFs, path: string): string {
  return decoder.decode(fs.readFile(path));
}

/** Pretty JSON + trailing newline — the repo-wide serialization for registry docs. */
function serializeDoc(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Thrown by {@link applyStatusEdit} for unknown names/versions/bad input. */
export class RegistryBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryBuildError';
  }
}

/**
 * `registry.config.json` — the hand-maintained identity file at a registry
 * repo's root. `name` is required; `repository` is stamped as every block
 * doc's `repository` (overridable per block via manifest `meta.repository`);
 * `trust: "official"` marks index entries (display hint only — spec-04
 * computes real trust).
 */
export interface RegistryRepoConfig {
  name: string;
  description?: string;
  homepage?: string;
  repository?: string;
  trust?: string;
}

/** One artifact the build packed (or, under `--check`, would pack). */
export interface PackedArtifact {
  name: string;
  version: string;
  /** Repo-relative artifact path (`<name>/dist/<version>/block.json`). */
  artifactPath: string;
  digest: string;
  size: number;
}

export interface BuildResult {
  /** Newly packed artifacts (the publish workflow attests exactly these). */
  packed: PackedArtifact[];
  /** Files written — or, under `--check`, files that WOULD change. */
  wrote: string[];
  /** Named hard failures (immutability violations, validation, missing config). */
  refusals: string[];
  warnings: string[];
}

export interface BuildOptions {
  fs?: BuildFs;
  /** Clock override (tests) — build timestamps come from here. */
  now?: () => Date;
  /** Core's strict parsers — mandatory (the command errors before calling without them). */
  validator: CoreValidatorModule;
  /** CI mode: run everything, write nothing, report would-be changes. */
  check?: boolean;
  /** Limit packing/doc regeneration to one block (index still spans all). */
  block?: string;
}

/** A registry version entry as this generator reads/writes it (lenient shape). */
interface VersionEntry extends Record<string, unknown> {
  artifactUrl: string;
  digest: string;
  size: number;
  publishedAt: string;
  dependencies: Record<string, string>;
  requires: Record<string, unknown>;
  attestationUrl?: string;
  status: string;
  statusReason?: string;
  yankedAt?: string;
}

interface BlockDoc extends Record<string, unknown> {
  name: string;
  latest: string;
  versions: Record<string, VersionEntry>;
  advisories?: unknown[];
}

// ---------------------------------------------------------------------------
// Discovery + source reading
// ---------------------------------------------------------------------------

/** Directory names that are never blocks (outputs, docs, repo plumbing). */
const NON_BLOCK_DIRS = new Set(['registry', 'schemas', 'docs', 'node_modules', 'site']);

/**
 * Discovers block source directories: every `<root>/<name>/block.json` one
 * level deep, skipping `registry/`, `schemas/`, `docs/`, and dot-directories.
 * Sorted for deterministic output.
 */
export function discoverBlocks(fs: BuildFs, root: string): string[] {
  return fs
    .readdir(root)
    .filter((name) => !name.startsWith('.') && !NON_BLOCK_DIRS.has(name))
    .filter((name) => {
      const dir = joinPath(root, name);
      return fs.exists(dir) && fs.stat(dir).isDirectory && fs.exists(joinPath(dir, 'block.json'));
    })
    .sort();
}

/**
 * Reads a block's manifest with `code/` embedded — the same shape (and the
 * same file ordering) `readLocalBlock`/`ion-drive block pack` produce, so the
 * packed bytes are identical.
 */
function readBlockSource(fs: BuildFs, root: string, name: string): Record<string, unknown> {
  const manifest = JSON.parse(readText(fs, joinPath(root, name, 'block.json'))) as Record<
    string,
    unknown
  >;
  const codeDir = joinPath(root, name, 'code');
  const embedded = (manifest.code as unknown[] | undefined) ?? [];
  if (embedded.length === 0 && fs.exists(codeDir)) {
    manifest.code = readCodeTree(fs, codeDir);
  }
  return manifest;
}

/** Mirrors `readCodeDir` (registry-client.ts) over a {@link BuildFs}, incl. its sort. */
function readCodeTree(fs: BuildFs, codeDir: string): { path: string; contents: string }[] {
  const files: { path: string; contents: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdir(dir)) {
      const full = joinPath(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (fs.stat(full).isDirectory) walk(full, rel);
      else files.push({ path: rel, contents: readText(fs, full) });
    }
  };
  walk(codeDir, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// registry.config.json
// ---------------------------------------------------------------------------

const CONFIG_HELP =
  'create it with at least { "name": "<registry display name>" } ' +
  '(optional: description, homepage, repository, trust)';

/** Reads + validates `registry.config.json`; a refusal string on failure. */
function readRegistryConfig(
  fs: BuildFs,
  root: string,
): { config?: RegistryRepoConfig; refusal?: string } {
  const path = joinPath(root, 'registry.config.json');
  if (!fs.exists(path)) {
    return { refusal: `${path} is missing — a registry repo needs one; ${CONFIG_HELP}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(fs, path));
  } catch (err) {
    return { refusal: `${path} is not valid JSON: ${(err as Error).message}` };
  }
  const config = parsed as RegistryRepoConfig | null;
  if (!config || typeof config !== 'object' || typeof config.name !== 'string' || !config.name) {
    return { refusal: `${path} is missing the required "name" field — ${CONFIG_HELP}` };
  }
  return { config };
}

// ---------------------------------------------------------------------------
// Latest computation
// ---------------------------------------------------------------------------

/**
 * The `latest` policy: highest non-prerelease version with `status: "active"`;
 * falls back to the highest active prerelease, then the highest version of any
 * status (so `latest ∈ versions` always holds even when everything is yanked).
 */
export function computeLatest(versions: Record<string, { status?: string }>): string {
  const keys = Object.keys(versions)
    .filter((v) => semver.valid(v) !== null)
    .sort(semver.rcompare);
  const active = keys.filter((v) => (versions[v]?.status ?? 'active') === 'active');
  return (
    active.find((v) => semver.prerelease(v) === null) ??
    active[0] ??
    keys[0] ??
    raise('registry block has no versions')
  );
}

function raise(message: string): never {
  throw new RegistryBuildError(message);
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/** A buffered write (flushed only when the whole build is refusal-free). */
interface PendingWrite {
  path: string;
  data: Uint8Array;
}

/**
 * Runs the full generator over a registry repo. Never throws for expected
 * failure modes — they come back as named `refusals` (and nothing is written).
 */
export function buildRegistry(root: string, opts: BuildOptions): BuildResult {
  const fs = opts.fs ?? realBuildFs();
  const now = opts.now ?? (() => new Date());
  const result: BuildResult = { packed: [], wrote: [], refusals: [], warnings: [] };
  const writes: PendingWrite[] = [];

  const { config, refusal } = readRegistryConfig(fs, root);
  if (!config) {
    result.refusals.push(refusal ?? 'unreadable registry.config.json');
    return result;
  }

  warnOnMissingGitattributes(fs, root, result);

  const names = discoverBlocks(fs, root);
  if (opts.block !== undefined && !names.includes(opts.block)) {
    result.refusals.push(
      `--block ${opts.block}: no such block directory (found: ${names.join(', ') || 'none'})`,
    );
    return result;
  }

  // Per-block pipeline: validate → pack/guard → regenerate the block doc.
  const docs = buildSelectedDocs({ fs, root, names, config, now, opts, result, writes });
  if (result.refusals.length > 0) return result; // abort: nothing is written

  // Index regeneration spans ALL discovered blocks — unselected ones
  // contribute their existing on-disk doc.
  const index = buildIndex({ fs, root, names, docs, config, now, opts, result, writes });
  if (result.refusals.length > 0 || index === null) return result;

  // registries.json is hand-maintained; the build VALIDATES it, never writes it.
  validateRegistriesDirectory(fs, root, opts.validator, result);
  if (result.refusals.length > 0) return result;

  flushWrites(fs, writes, result, opts.check === true);
  return result;
}

/** Runs the per-block pipeline for every selected block (all, or `--block <name>`). */
function buildSelectedDocs(input: {
  fs: BuildFs;
  root: string;
  names: string[];
  config: RegistryRepoConfig;
  now: () => Date;
  opts: BuildOptions;
  result: BuildResult;
  writes: PendingWrite[];
}): Map<string, BlockDoc> {
  const selected = input.opts.block === undefined ? input.names : [input.opts.block];
  const docs = new Map<string, BlockDoc>();
  for (const name of selected) {
    const doc = buildBlockDoc({ ...input, name });
    if (doc) docs.set(name, doc);
  }
  return docs;
}

/** Flushes buffered writes — or, under `--check`, only reports them. */
function flushWrites(
  fs: BuildFs,
  writes: PendingWrite[],
  result: BuildResult,
  check: boolean,
): void {
  for (const write of writes) {
    result.wrote.push(write.path);
    if (!check) {
      fs.mkdir(dirnameOf(write.path));
      fs.writeFile(write.path, write.data);
    }
  }
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : path.slice(0, idx);
}

/** Everything one block's doc-building step needs. */
interface BlockBuildContext {
  fs: BuildFs;
  root: string;
  name: string;
  config: RegistryRepoConfig;
  now: () => Date;
  opts: BuildOptions;
  result: BuildResult;
  writes: PendingWrite[];
}

/**
 * Validates one block, packs its current version if missing (guarding released
 * bytes), and regenerates `registry/blocks/<name>.json` append-only. Returns
 * the doc, or null after pushing refusals.
 */
function buildBlockDoc(ctx: BlockBuildContext): BlockDoc | null {
  const { fs, root, name, opts, result } = ctx;

  let manifest: Record<string, unknown>;
  try {
    manifest = readBlockSource(fs, root, name);
    opts.validator.parseManifest(manifest);
  } catch (err) {
    result.refusals.push(`${name}/block.json: ${(err as Error).message}`);
    return null;
  }
  const version = String(manifest.version ?? '');
  if (semver.valid(version) !== version) {
    result.refusals.push(`${name}/block.json: version ${JSON.stringify(version)} is not semver`);
    return null;
  }

  const existingDoc = readExistingDoc(ctx);
  if (existingDoc === undefined) return null; // refusal already recorded

  const packed = packCurrentVersion(ctx, manifest, version, existingDoc);
  if (packed === null) return null;

  if (!verifyReleasedVersions(ctx, existingDoc)) return null;

  return assembleBlockDoc(ctx, manifest, version, existingDoc, packed);
}

/** Existing `registry/blocks/<name>.json`, `null` when absent, `undefined` on refusal. */
function readExistingDoc(ctx: BlockBuildContext): BlockDoc | null | undefined {
  const path = joinPath(ctx.root, 'registry', 'blocks', `${ctx.name}.json`);
  if (!ctx.fs.exists(path)) return null;
  try {
    return JSON.parse(readText(ctx.fs, path)) as BlockDoc;
  } catch (err) {
    ctx.result.refusals.push(`${relPath(ctx, path)}: not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
}

function relPath(ctx: BlockBuildContext, absolute: string): string {
  return absolute.startsWith(`${ctx.root}/`) ? absolute.slice(ctx.root.length + 1) : absolute;
}

/**
 * The pack step + the mutated-artifact guard for the *current* manifest
 * version: repack in memory; when the artifact already exists on disk the
 * bytes must match exactly (a mismatch means the source changed without a
 * version bump — the immutability contract, spec-01 §5). Returns the packed
 * digest/size, or null after a refusal.
 */
function packCurrentVersion(
  ctx: BlockBuildContext,
  manifest: Record<string, unknown>,
  version: string,
  existingDoc: BlockDoc | null,
): PackedArtifact | null {
  const { fs, root, name, result } = ctx;
  const artifactRel = `${name}/dist/${version}/block.json`;
  const artifactPath = joinPath(root, artifactRel);
  const packedBytes = packBytes(manifest);

  if (fs.exists(artifactPath)) {
    const onDisk = fs.readFile(artifactPath);
    if (!bytesEqual(onDisk, packedBytes)) {
      result.refusals.push(
        `${artifactRel}: released artifact does not match the current sources — published versions are immutable; bump ${name}'s version instead of editing ${version}`,
      );
      return null;
    }
  } else if (existingDoc?.versions?.[version]) {
    // An entry exists but its artifact vanished: repacking could silently
    // change released bytes, so this is a refusal, not a re-pack.
    result.refusals.push(
      `${artifactRel}: missing artifact for released version ${version} (its registry entry exists) — restore the file; published artifacts are immutable`,
    );
    return null;
  } else {
    ctx.writes.push({ path: artifactPath, data: packedBytes });
    const digest = computeDigest(packedBytes);
    const packed: PackedArtifact = {
      name,
      version,
      artifactPath: artifactRel,
      digest,
      size: packedBytes.byteLength,
    };
    result.packed.push(packed);
    return packed;
  }
  // Artifact existed and matched — nothing new to pack; digest still needed
  // in case the doc entry is being (re)appended from a pre-packed artifact.
  return {
    name,
    version,
    artifactPath: artifactRel,
    digest: computeDigest(packedBytes),
    size: packedBytes.byteLength,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The released-versions guard: every version entry already in the doc must
 * still have its artifact on disk, digest/size-consistent with the entry
 * (catches both tampered artifacts and hand-mutated entries — spec-05 AC2).
 * The current manifest version additionally got the byte-exact
 * source-vs-artifact compare in {@link packCurrentVersion}.
 */
function verifyReleasedVersions(ctx: BlockBuildContext, existingDoc: BlockDoc | null): boolean {
  if (!existingDoc) return true;
  const { fs, root, name, result } = ctx;
  for (const [version, entry] of Object.entries(existingDoc.versions ?? {})) {
    const artifactRel = `${name}/dist/${version}/block.json`;
    const artifactPath = joinPath(root, artifactRel);
    if (!fs.exists(artifactPath)) {
      // (Unreachable for currentVersion — packCurrentVersion already refused.)
      result.refusals.push(
        `${artifactRel}: missing artifact for released version ${version} — restore the file; published artifacts are immutable`,
      );
      return false;
    }
    const bytes = fs.readFile(artifactPath);
    const digest = computeDigest(bytes);
    if (digest !== entry.digest || bytes.byteLength !== entry.size) {
      result.refusals.push(
        `registry/blocks/${name}.json: versions["${version}"] no longer matches its artifact (${artifactRel}) — released entries and artifact bytes are immutable`,
      );
      return false;
    }
  }
  return true;
}

/**
 * Assembles the regenerated per-block doc: existing version entries verbatim
 * (D5's attestationUrl absent→present is the sole legal mutation), the current
 * version appended when new, display metadata refreshed from the manifest
 * (mutable by design), `latest` recomputed. Validated with core's strict
 * parser before it is accepted.
 */
function assembleBlockDoc(
  ctx: BlockBuildContext,
  manifest: Record<string, unknown>,
  version: string,
  existingDoc: BlockDoc | null,
  packed: PackedArtifact,
): BlockDoc | null {
  const { name, config, now, opts, result } = ctx;

  const versions: Record<string, VersionEntry> = {};
  for (const [v, entry] of Object.entries(existingDoc?.versions ?? {})) {
    versions[v] = withAttestationUrl(ctx, v, { ...entry });
  }
  if (!versions[version]) {
    versions[version] = withAttestationUrl(ctx, version, {
      artifactUrl: `../../${name}/dist/${version}/block.json`,
      digest: packed.digest,
      size: packed.size,
      publishedAt: isoNow(now),
      dependencies: (manifest.dependencies as Record<string, string> | undefined) ?? {},
      requires: (manifest.requires as Record<string, unknown> | undefined) ?? {},
      status: 'active',
    });
  }

  const ordered: Record<string, VersionEntry> = {};
  for (const v of Object.keys(versions).sort(semver.rcompare)) {
    const entry = versions[v];
    if (entry) ordered[v] = entry;
  }

  const meta = (manifest.meta as Record<string, unknown> | undefined) ?? {};
  const doc: BlockDoc = {
    $schema: 'https://iondrive.dev/schemas/registry-block.v1.json',
    schemaVersion: 1,
    name,
    ...optional('title', manifest.title),
    ...optional('description', manifest.description),
    ...(Array.isArray(manifest.categories) && manifest.categories.length > 0
      ? { categories: manifest.categories }
      : {}),
    ...optional(
      'repository',
      typeof meta.repository === 'string' ? meta.repository : config.repository,
    ),
    ...optional('homepage', typeof meta.homepage === 'string' ? meta.homepage : undefined),
    latest: computeLatest(ordered),
    versions: ordered,
    advisories: existingDoc?.advisories ?? [],
  };

  try {
    opts.validator.parseRegistryBlock(doc);
  } catch (err) {
    result.refusals.push(`registry/blocks/${name}.json: ${(err as Error).message}`);
    return null;
  }

  queueDocWrite(ctx, joinPath(ctx.root, 'registry', 'blocks', `${name}.json`), doc);
  return doc;
}

/** `{ key: value }` when the value is a non-empty string, `{}` otherwise. */
function optional(key: string, value: unknown): Record<string, unknown> {
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {};
}

/**
 * D5: sets `attestationUrl` iff the sigstore bundle exists on disk beside the
 * artifact and the entry doesn't already carry one. An existing value is
 * never touched (immutable once present); the URL is never fabricated.
 */
function withAttestationUrl(
  ctx: BlockBuildContext,
  version: string,
  entry: VersionEntry,
): VersionEntry {
  if (entry.attestationUrl !== undefined) return entry;
  const bundleRel = `${ctx.name}/dist/${version}/block.json.sigstore.json`;
  if (ctx.fs.exists(joinPath(ctx.root, bundleRel))) {
    entry.attestationUrl = `../../${bundleRel}`;
  }
  return entry;
}

/** Queues a doc write only when its serialized bytes differ from disk (idempotency). */
function queueDocWrite(ctx: BlockBuildContext, path: string, doc: unknown): void {
  const next = serializeDoc(doc);
  if (ctx.fs.exists(path) && readText(ctx.fs, path) === next) return;
  ctx.writes.push({ path, data: encoder.encode(next) });
}

function isoNow(now: () => Date): string {
  return `${now().toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface IndexBuildContext {
  fs: BuildFs;
  root: string;
  names: string[];
  docs: Map<string, BlockDoc>;
  config: RegistryRepoConfig;
  now: () => Date;
  opts: BuildOptions;
  result: BuildResult;
  writes: PendingWrite[];
}

/**
 * Regenerates `registry/index.json` from the per-block docs (freshly built
 * for selected blocks; read from disk for the rest under `--block`). The
 * index is written only when it materially changed (`generatedAt` alone never
 * forces a write — that keeps a no-op build a true no-op).
 */
function buildIndex(ctx: IndexBuildContext): Record<string, unknown> | null {
  const { fs, root, names, docs, config, opts, result } = ctx;

  const blocks: Record<string, unknown> = {};
  for (const name of names) {
    const doc = docs.get(name) ?? readDocForIndex(ctx, name);
    if (doc === undefined) return null; // refusal recorded
    if (doc === null) continue; // not yet in the registry (partial --block build)
    blocks[name] = {
      ...optional('title', doc.title),
      ...optional('description', doc.description),
      ...(Array.isArray(doc.categories) && doc.categories.length > 0
        ? { categories: doc.categories }
        : {}),
      latest: doc.latest,
      blockUrl: `blocks/${name}.json`,
      ...(config.trust === 'official' ? { trust: 'official' } : {}),
    };
  }

  const index: Record<string, unknown> = {
    $schema: 'https://iondrive.dev/schemas/registry-index.v1.json',
    schemaVersion: 1,
    name: config.name,
    ...optional('description', config.description),
    ...optional('homepage', config.homepage),
    generatedAt: isoNow(ctx.now),
    blocks,
  };

  try {
    opts.validator.parseRegistryIndex(index);
  } catch (err) {
    result.refusals.push(`registry/index.json: ${(err as Error).message}`);
    return null;
  }

  const path = joinPath(root, 'registry', 'index.json');
  if (indexMateriallyChanged(fs, path, index)) {
    ctx.writes.push({ path, data: encoder.encode(serializeDoc(index)) });
  }
  return index;
}

/** Existing doc for an unselected block; `null` when absent, `undefined` on refusal. */
function readDocForIndex(ctx: IndexBuildContext, name: string): BlockDoc | null | undefined {
  const path = joinPath(ctx.root, 'registry', 'blocks', `${name}.json`);
  if (!ctx.fs.exists(path)) {
    ctx.result.warnings.push(
      `${name}: no registry/blocks/${name}.json yet — run a full build to include it in the index`,
    );
    return null;
  }
  try {
    return JSON.parse(readText(ctx.fs, path)) as BlockDoc;
  } catch (err) {
    ctx.result.refusals.push(
      `registry/blocks/${name}.json: not valid JSON: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/** True when the emitted index differs from disk beyond `generatedAt`. */
function indexMateriallyChanged(
  fs: BuildFs,
  path: string,
  index: Record<string, unknown>,
): boolean {
  if (!fs.exists(path)) return true;
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readText(fs, path)) as Record<string, unknown>;
  } catch {
    return true;
  }
  const normalize = (doc: Record<string, unknown>) =>
    serializeDoc({ ...doc, generatedAt: 'normalized' });
  return normalize(existing) !== normalize(index);
}

// ---------------------------------------------------------------------------
// .gitattributes (spec-06 §2 / the spec-05 carry-over)
// ---------------------------------------------------------------------------

/**
 * Warns when the registry root has no `.gitattributes` covering `dist` —
 * sha256 digests are computed over exact bytes, and a Windows checkout with
 * `core.autocrlf` would serve CRLF-mangled artifacts that fail every
 * consumer's digest verification. A warning, not a refusal: the generator
 * cannot know how the repo is checked out or served.
 */
function warnOnMissingGitattributes(fs: BuildFs, root: string, result: BuildResult): void {
  const advice =
    'add a .gitattributes with `dist/** -text` (and `*.sigstore.json -text`) — sha256 digests are over exact bytes and autocrlf checkouts corrupt released artifacts';
  const path = joinPath(root, '.gitattributes');
  if (!fs.exists(path)) {
    result.warnings.push(`no .gitattributes at the registry root — ${advice}`);
    return;
  }
  const coversDist = readText(fs, path)
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('#') && trimmed.includes('dist');
    });
  if (!coversDist) {
    result.warnings.push(`.gitattributes does not cover dist/ artifacts — ${advice}`);
  }
}

// ---------------------------------------------------------------------------
// registries.json (validated when present; never generated)
// ---------------------------------------------------------------------------

function validateRegistriesDirectory(
  fs: BuildFs,
  root: string,
  validator: CoreValidatorModule,
  result: BuildResult,
): void {
  const path = joinPath(root, 'registries.json');
  if (!fs.exists(path)) return;
  try {
    validator.parseRegistriesDirectory(JSON.parse(readText(fs, path)));
  } catch (err) {
    result.refusals.push(`registries.json: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// registry yank / deprecate — the mutable-status writer
// ---------------------------------------------------------------------------

export interface StatusEditOptions {
  fs?: BuildFs;
  now?: () => Date;
  reason?: string;
}

export interface StatusEditResult {
  name: string;
  version: string;
  status: 'deprecated' | 'yanked';
  /** The block's recomputed `latest` after the edit. */
  latest: string;
}

/**
 * Edits the mutable status fields of one released version in a local registry
 * checkout (`registry yank` / `registry deprecate` — the git-registry admin
 * loop). Recomputes `latest` in both the block doc and the index; refuses
 * unknown names/versions.
 * @throws {RegistryBuildError}
 */
export function applyStatusEdit(
  root: string,
  ref: string,
  status: 'deprecated' | 'yanked',
  opts: StatusEditOptions = {},
): StatusEditResult {
  const fs = opts.fs ?? realBuildFs();
  const now = opts.now ?? (() => new Date());

  const at = ref.lastIndexOf('@');
  if (at <= 0) {
    throw new RegistryBuildError(
      `Expected <name>@<version> (e.g. crm@0.2.0), got ${JSON.stringify(ref)}`,
    );
  }
  const name = ref.slice(0, at);
  const version = ref.slice(at + 1);

  const docPath = joinPath(root, 'registry', 'blocks', `${name}.json`);
  if (!fs.exists(docPath)) {
    throw new RegistryBuildError(
      `Unknown block "${name}" — no registry/blocks/${name}.json in ${root}`,
    );
  }
  const doc = JSON.parse(readText(fs, docPath)) as BlockDoc;
  const entry = doc.versions?.[version];
  if (!entry) {
    throw new RegistryBuildError(
      `Unknown version "${version}" of "${name}" — released: ${Object.keys(doc.versions ?? {}).join(', ')}`,
    );
  }

  entry.status = status;
  if (opts.reason !== undefined) entry.statusReason = opts.reason;
  // JSON.stringify drops undefined values, so this clears yankedAt on un-yank.
  entry.yankedAt = status === 'yanked' ? isoNow(now) : undefined;

  doc.latest = computeLatest(doc.versions);
  fs.writeFile(docPath, encoder.encode(serializeDoc(doc)));

  // Keep the index's summary in sync (latest + freshness).
  const indexPath = joinPath(root, 'registry', 'index.json');
  if (fs.exists(indexPath)) {
    const index = JSON.parse(readText(fs, indexPath)) as {
      generatedAt?: string;
      blocks?: Record<string, { latest?: string }>;
    };
    const summary = index.blocks?.[name];
    if (summary) {
      summary.latest = doc.latest;
      index.generatedAt = isoNow(now);
      fs.writeFile(indexPath, encoder.encode(serializeDoc(index)));
    }
  }

  return { name, version, status, latest: doc.latest };
}
