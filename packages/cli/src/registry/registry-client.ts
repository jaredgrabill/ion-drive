/**
 * Registry client — resolves block manifests from a source (Phase 14 Tier 4).
 *
 * Three sources are supported, mirroring shadcn's registry model (ADR-018
 * amendment — blocks live in their own repos, not bundled with the CLI):
 *
 *  - **registry name** — `crm` or `crm@0.2.0`: looked up in the registry
 *    **index**, a flat JSON file mapping names → versions → artifact URLs.
 *    Default index: the `jaredgrabill/ion-drive-blocks` repo; override with
 *    the `ION_DRIVE_REGISTRY` env var or `registryUrl` in `ion.config.json`.
 *  - **direct URL** — any `http(s)://…/block.json`, so third-party/self-hosted
 *    blocks work without a registry entry.
 *  - **local path** — `ion-drive add ../block-crm`: reads `block.json` (and a
 *    sibling `code/` directory when the manifest doesn't embed its files).
 *    This is the dev loop for authoring blocks.
 *
 * The fetched index is cached (in-process + a short-TTL disk cache) so `list`
 * and dependency resolution don't refetch. The client stays dumb about
 * *installing* — the server performs the authoritative validation.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readConfig } from '../config.js';

/** A manifest is an opaque object here; the server validates it on install. */
export type Manifest = Record<string, unknown> & {
  name: string;
  /** Block-ref → semver-range record (manifest v1, spec-02). */
  dependencies?: Record<string, string>;
  code?: { path: string; contents: string }[];
};

/** Summary of a registry entry (for `ion-drive list`). */
export interface BlockSummary {
  name: string;
  title: string;
  description: string;
  version: string;
  categories: string[];
  dependencies: string[];
}

/** One block's entry in the registry index. */
interface RegistryIndexEntry {
  title?: string;
  description?: string;
  categories?: string[];
  dependencies?: string[];
  latest: string;
  /** version → artifact (block.json) URL */
  versions: Record<string, string>;
}

interface RegistryIndex {
  blocks: Record<string, RegistryIndexEntry>;
}

export class RegistryError extends Error {}

export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/jaredgrabill/ion-drive-blocks/main/registry/index.json';

/** Where the index disk cache lives; TTL keeps `add` after `list` instant. */
const CACHE_DIR = join(homedir(), '.ion-drive');
const CACHE_FILE = join(CACHE_DIR, 'registry-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

/** The registry index URL for this invocation (env > project config > default). */
export function registryUrl(dir = process.cwd()): string {
  if (process.env.ION_DRIVE_REGISTRY) return process.env.ION_DRIVE_REGISTRY;
  const config = readConfig(dir);
  return config.registryUrl ?? DEFAULT_REGISTRY_URL;
}

let indexCache: { url: string; index: RegistryIndex } | undefined;

/** Fetches (and caches) the registry index. */
export async function fetchIndex(url = registryUrl()): Promise<RegistryIndex> {
  if (indexCache?.url === url) return indexCache.index;

  const disk = readDiskCache(url);
  if (disk) {
    indexCache = { url, index: disk };
    return disk;
  }

  const index = validateIndex(await fetchJson(url), url);
  indexCache = { url, index };
  writeDiskCache(url, index);
  return index;
}

/** Lists the registry's blocks (for `ion-drive list`). */
export async function listAvailable(): Promise<BlockSummary[]> {
  const index = await fetchIndex();
  return Object.entries(index.blocks)
    .map(([name, entry]) => ({
      name,
      title: entry.title ?? name,
      description: entry.description ?? '',
      version: entry.latest,
      categories: entry.categories ?? [],
      dependencies: entry.dependencies ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when `ref` looks like a remote registry URL rather than a bare name. */
export function isUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/** True when `ref` points at a local block directory (the block-dev loop). */
export function isLocalPath(ref: string): boolean {
  if (ref.startsWith('.') || isAbsolute(ref) || ref.includes(sep) || ref.includes('/')) {
    return existsSync(join(resolve(ref), 'block.json'));
  }
  return false;
}

/**
 * Resolves a single manifest by registry name (`crm`, `crm@0.2.0`), direct
 * URL, or local path.
 */
export async function getManifest(ref: string): Promise<Manifest> {
  if (isUrl(ref)) return asManifest(await fetchJson(ref), ref);
  if (isLocalPath(ref)) return readLocalBlock(ref);

  const [name, version] = splitNameVersion(ref);
  const index = await fetchIndex();
  const entry = index.blocks[name];
  if (!entry) {
    const known = Object.keys(index.blocks).sort().join(', ') || '(registry is empty)';
    throw new RegistryError(`Unknown block "${name}". Available: ${known}`);
  }
  const wanted = version ?? entry.latest;
  const artifactUrl = entry.versions[wanted];
  if (!artifactUrl) {
    throw new RegistryError(
      `Block "${name}" has no version ${wanted}. Available: ${Object.keys(entry.versions).join(', ')}`,
    );
  }
  return asManifest(await fetchJson(artifactUrl), artifactUrl);
}

/** Splits `crm@0.2.0` into name + optional version. */
function splitNameVersion(ref: string): [string, string | undefined] {
  const at = ref.indexOf('@', 1);
  if (at === -1) return [ref, undefined];
  return [ref.slice(0, at), ref.slice(at + 1)];
}

/**
 * Reads a block from a local directory: `block.json` plus, when the manifest
 * doesn't embed `code`, the files under `code/` (authoring layout).
 */
export function readLocalBlock(path: string): Manifest {
  const root = resolve(path);
  const manifestPath = join(root, 'block.json');
  let manifest: Manifest;
  try {
    manifest = asManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    throw new RegistryError(`Could not read ${manifestPath}: ${(err as Error).message}`);
  }
  const codeDir = join(root, 'code');
  if ((manifest.code ?? []).length === 0 && existsSync(codeDir)) {
    manifest.code = readCodeDir(codeDir);
  }
  return manifest;
}

/** Recursively reads a `code/` directory into embedded manifest entries. */
function readCodeDir(codeDir: string): { path: string; contents: string }[] {
  const files: { path: string; contents: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push({
          path: relative(codeDir, full).split(sep).join('/'),
          contents: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(codeDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Block refs a manifest depends on — the keys of its v1 name → semver-range
 * record. Only the record form counts: the legacy array (or any non-object)
 * yields `[]` — `Object.keys` on an array would return its *indices* and send
 * the resolver hunting for a block named "0".
 */
export function dependenciesOf(manifest: Manifest): string[] {
  const deps: unknown = manifest.dependencies;
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return [];
  return Object.keys(deps);
}

// ---------------------------------------------------------------------------
// Fetch + cache plumbing
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new RegistryError(`Could not reach ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new RegistryError(`Registry returned ${res.status} for ${url}`);
  try {
    return await res.json();
  } catch {
    throw new RegistryError(`Registry response at ${url} is not JSON`);
  }
}

function asManifest(value: unknown, source: string): Manifest {
  const manifest = value as Manifest | null;
  if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string') {
    throw new RegistryError(`Manifest at ${source} is missing a "name"`);
  }
  return manifest;
}

function validateIndex(value: unknown, url: string): RegistryIndex {
  const index = value as RegistryIndex | null;
  if (!index || typeof index !== 'object' || typeof index.blocks !== 'object') {
    throw new RegistryError(`Registry index at ${url} is malformed (expected { blocks: {…} })`);
  }
  return index;
}

function readDiskCache(url: string): RegistryIndex | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as {
      url: string;
      fetchedAt: number;
      index: RegistryIndex;
    };
    if (raw.url !== url || Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null;
    return raw.index;
  } catch {
    return null;
  }
}

function writeDiskCache(url: string, index: RegistryIndex): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ url, fetchedAt: Date.now(), index }), 'utf8');
  } catch {
    /* cache is best-effort */
  }
}

/** Test hook: clears the in-process index cache. */
export function resetRegistryCache(): void {
  indexCache = undefined;
}
