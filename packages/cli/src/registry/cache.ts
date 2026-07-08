/**
 * Per-registry disk cache for registry metadata (spec-03 §3).
 *
 * One JSON file per registry at
 * `~/.ion-drive/registry-cache/<sha256(registryUrl)>.json`, holding
 * `{ fetchedAt, index, blocks: { <name>: { fetchedAt, doc } } }` with a 5-min
 * TTL. Everything is best-effort: a write failure or a corrupt file is a cache
 * miss, never an error. Two hard rules:
 *
 * - **Auth never touches disk** — only fetched documents are serialized;
 *   headers/params/tokens are not part of the cache shape (asserted by a unit
 *   test that greps the written bytes).
 * - **Artifacts are not cached** — they're verified-then-used in-process
 *   (spec-04), and they're small.
 *
 * The cache directory is injectable for tests. On the first write the legacy
 * Phase-14 single-file cache (`<parent>/registry-cache.json`, i.e.
 * `~/.ion-drive/registry-cache.json` by default) is best-effort unlinked —
 * its unversioned-index contents are useless to the v1 protocol.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Registry metadata TTL — indexes/block files are mutable (spec-01 §7). */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Default cache directory (`~/.ion-drive/registry-cache/`). The
 * `ION_DRIVE_CACHE_DIR` env var relocates it (tests + hermetic CI/smoke runs).
 */
export function defaultCacheDir(): string {
  return process.env.ION_DRIVE_CACHE_DIR ?? join(homedir(), '.ion-drive', 'registry-cache');
}

export interface CacheOptions {
  /** Override the cache directory (tests). Default: {@link defaultCacheDir}. */
  cacheDir?: string;
  /** Clock override (tests). */
  now?: () => number;
}

/** On-disk shape of one registry's cache file. */
interface CacheFile {
  /** When the index was fetched (epoch ms). */
  fetchedAt?: number;
  index?: unknown;
  blocks: Record<string, { fetchedAt: number; doc: unknown }>;
}

/** The cache file path for a registry URL: sha256(url) keeps it filename-safe. */
export function cacheFilePath(registryUrl: string, cacheDir = defaultCacheDir()): string {
  const hash = createHash('sha256').update(registryUrl).digest('hex');
  return join(cacheDir, `${hash}.json`);
}

/** Reads a registry's cache file; corrupt/missing ⇒ empty (a miss, never an error). */
function readCacheFile(registryUrl: string, cacheDir: string): CacheFile {
  try {
    const raw = JSON.parse(readFileSync(cacheFilePath(registryUrl, cacheDir), 'utf8')) as CacheFile;
    if (typeof raw !== 'object' || raw === null) return { blocks: {} };
    if (typeof raw.blocks !== 'object' || raw.blocks === null) raw.blocks = {};
    return raw;
  } catch {
    return { blocks: {} };
  }
}

/** Best-effort write; also unlinks the legacy single-file cache once (C3). */
function writeCacheFile(registryUrl: string, file: CacheFile, cacheDir: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    unlinkLegacyCache(cacheDir);
    writeFileSync(cacheFilePath(registryUrl, cacheDir), JSON.stringify(file), 'utf8');
  } catch {
    /* cache is best-effort */
  }
}

let legacyUnlinkAttempted = false;

/** Removes the retired Phase-14 single-file cache next to the cache dir, once. */
function unlinkLegacyCache(cacheDir: string): void {
  if (legacyUnlinkAttempted) return;
  legacyUnlinkAttempted = true;
  try {
    unlinkSync(join(dirname(cacheDir), 'registry-cache.json'));
  } catch {
    /* absent or locked — either way, done trying */
  }
}

/** Returns the cached index for a registry, or null on miss/expiry. */
export function readCachedIndex(registryUrl: string, opts: CacheOptions = {}): unknown | null {
  const file = readCacheFile(registryUrl, opts.cacheDir ?? defaultCacheDir());
  const now = (opts.now ?? Date.now)();
  if (file.index === undefined || file.fetchedAt === undefined) return null;
  if (now - file.fetchedAt > CACHE_TTL_MS) return null;
  return file.index;
}

/** Caches a registry's index document (best-effort). */
export function writeCachedIndex(
  registryUrl: string,
  index: unknown,
  opts: CacheOptions = {},
): void {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const file = readCacheFile(registryUrl, cacheDir);
  file.index = index;
  file.fetchedAt = (opts.now ?? Date.now)();
  writeCacheFile(registryUrl, file, cacheDir);
}

/** Returns a cached `blocks/<name>.json` document, or null on miss/expiry. */
export function readCachedBlock(
  registryUrl: string,
  name: string,
  opts: CacheOptions = {},
): unknown | null {
  const file = readCacheFile(registryUrl, opts.cacheDir ?? defaultCacheDir());
  const entry = file.blocks[name];
  if (!entry) return null;
  const now = (opts.now ?? Date.now)();
  if (now - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry.doc;
}

/** Caches one block's version-history document (best-effort). */
export function writeCachedBlock(
  registryUrl: string,
  name: string,
  doc: unknown,
  opts: CacheOptions = {},
): void {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const file = readCacheFile(registryUrl, cacheDir);
  file.blocks[name] = { fetchedAt: (opts.now ?? Date.now)(), doc };
  writeCacheFile(registryUrl, file, cacheDir);
}

/** Test hook: re-arms the one-shot legacy-cache unlink. */
export function resetLegacyUnlink(): void {
  legacyUnlinkAttempted = false;
}
