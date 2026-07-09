/**
 * Registry client — protocol-v1 fetch layer for block registries (spec-03 §3).
 *
 * Four sources are supported, mirroring shadcn's registry model (ADR-022):
 *
 *  - **registry ref** — `crm`, `crm@^0.2.0`, `@acme/billing@1.x`: resolved in
 *    a configured registry ({@link resolveRegistry}) via its `index.json` →
 *    `blocks/<name>.json` → immutable versioned artifact.
 *  - **direct URL** — any `http(s)://…/block.json`, so one-off blocks work
 *    without a registry entry.
 *  - **local path** — `ion-drive add ../block-crm`: reads `block.json` (and a
 *    sibling `code/` directory when the manifest doesn't embed its files).
 *    This is the dev loop for authoring blocks.
 *
 * Fetch rules: every URL passes {@link isPermittedRegistryUrl} (`https:`
 * always, `http:` only on localhost); registry metadata goes through the
 * per-registry disk cache (`cache.ts`, 5-min TTL, `--no-cache` bypasses
 * reads) plus an in-process memo; **artifacts are never cached** and are
 * fetched as **raw bytes** ({@link fetchArtifact}) — spec-04 hashes those
 * exact bytes before anything parses them. Auth headers/params come from the
 * registry's config entry with `${VAR}` env expansion at fetch time.
 *
 * The client stays dumb about *installing* — the server performs the
 * authoritative validation.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  type IonProjectConfig,
  defaultRegistryNamespace,
  effectiveRegistries,
  expandEnvPlaceholders,
} from '../config.js';
import {
  type CacheOptions,
  readCachedBlock,
  readCachedIndex,
  writeCachedBlock,
  writeCachedIndex,
} from './cache.js';
import {
  type RegistriesDirectoryDoc,
  type RegistryBlockDoc,
  RegistryError,
  type RegistryIndexDoc,
  isPermittedRegistryUrl,
  parseBlockDoc,
  parseIndexDoc,
  parseRegistriesDirectoryDoc,
  resolveRegistryUrl,
} from './protocol.js';
import { computeDigest } from './verify.js';

// Re-exports so commands keep one import site for the registry layer.
export { RegistryError, isPermittedRegistryUrl, resolveRegistryUrl } from './protocol.js';
export type {
  RegistriesDirectoryDoc,
  RegistriesDirectoryEntry,
  RegistryBlockDoc,
  RegistryIndexDoc,
  RegistryVersionEntry,
} from './protocol.js';
export { isLocalPath, isUrl } from './ref.js';

/** A manifest is an opaque object here; the server validates it on install. */
export type Manifest = Record<string, unknown> & {
  name: string;
  /** Block-ref → semver-range record (manifest v1, spec-02). */
  dependencies?: Record<string, string>;
  code?: { path: string; contents: string }[];
};

/** A namespace resolved to a fetchable registry (headers/params env-expanded). */
export interface ResolvedRegistry {
  namespace: string;
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
}

/** Options threaded through the fetch layer. */
export interface FetchOptions extends CacheOptions {
  /** Bypass cache reads (still writes — the next command benefits). */
  noCache?: boolean;
  /** Fetch override (tests / fixture servers). */
  fetchImpl?: typeof fetch;
}

/**
 * Resolves a namespace (or the default when `undefined`) to a fetchable
 * registry. `${VAR}` placeholders in headers/params are expanded **here** —
 * before any network call — so an unset variable fails fast with its name.
 * @throws {RegistryError} for an unconfigured namespace
 * @throws {ConfigError} for an unset `${VAR}`
 */
export function resolveRegistry(
  namespace: string | undefined,
  config: IonProjectConfig,
  env: Record<string, string | undefined> = process.env,
): ResolvedRegistry {
  const registries = effectiveRegistries(config, env);
  const ns = namespace ?? defaultRegistryNamespace(config);
  const entry = registries[ns];
  if (!entry) {
    throw new RegistryError(
      `Unknown registry "${ns}" — add ${ns} to registries in ion.config.json`,
    );
  }
  const expand = (values: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, expandEnvPlaceholders(value, env, ns)]),
    );
  return {
    namespace: ns,
    url: entry.url,
    headers: expand(entry.headers),
    params: expand(entry.params),
  };
}

// --- In-process memo (one command = one process; avoids re-reading disk) -----

const memo = new Map<string, { index?: RegistryIndexDoc; blocks: Map<string, RegistryBlockDoc> }>();

function memoFor(url: string) {
  let entry = memo.get(url);
  if (!entry) {
    entry = { blocks: new Map() };
    memo.set(url, entry);
  }
  return entry;
}

/** Test hook: clears the in-process memo layer. */
export function resetRegistryCache(): void {
  memo.clear();
}

// --- Fetch plumbing -----------------------------------------------------------

/** Appends a registry's `params` to a URL (private-registry query tokens). */
export function withParams(url: string, params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return url;
  const parsed = new URL(url);
  for (const [key, value] of entries) parsed.searchParams.set(key, value);
  return parsed.toString();
}

/** Guards every outbound URL: https always, http only on localhost (spec-01 §1). */
function assertPermitted(url: string): void {
  if (!isPermittedRegistryUrl(url)) {
    throw new RegistryError(
      `Refusing to fetch ${url} — registries must be https (http is allowed only for localhost/127.0.0.1)`,
    );
  }
}

async function fetchJson(
  url: string,
  reg: Pick<ResolvedRegistry, 'headers' | 'params'>,
  opts: FetchOptions,
): Promise<unknown> {
  const target = withParams(url, reg.params);
  assertPermitted(target);
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(target, { headers: reg.headers });
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

/** Fetches (and caches) a registry's `index.json`, validated per protocol v1. */
export async function fetchIndex(
  reg: ResolvedRegistry,
  opts: FetchOptions = {},
): Promise<RegistryIndexDoc> {
  const slot = memoFor(reg.url);
  if (!opts.noCache) {
    if (slot.index) return slot.index;
    const cached = readCachedIndex(reg.url, opts);
    if (cached !== null) {
      const index = parseIndexDoc(cached, reg.url);
      slot.index = index;
      return index;
    }
  }
  const index = parseIndexDoc(await fetchJson(reg.url, reg, opts), reg.url);
  slot.index = index;
  writeCachedIndex(reg.url, index, opts);
  return index;
}

/**
 * Fetches (and caches) a block's `blocks/<name>.json` version history. The
 * block file's URL comes from the index entry's `blockUrl`, resolved relative
 * to the **index** URL (spec-01 §2); the returned `url` is what version
 * entries' `artifactUrl`s resolve against.
 */
export async function fetchBlock(
  reg: ResolvedRegistry,
  name: string,
  opts: FetchOptions = {},
): Promise<{ doc: RegistryBlockDoc; url: string }> {
  const index = await fetchIndex(reg, opts);
  const entry = index.blocks[name];
  if (!entry) {
    throw new RegistryError(`Registry ${reg.namespace} (${reg.url}) has no block "${name}"`);
  }
  const url = resolveRegistryUrl(entry.blockUrl, reg.url);

  const slot = memoFor(reg.url);
  if (!opts.noCache) {
    const memoized = slot.blocks.get(name);
    if (memoized) return { doc: memoized, url };
    const cached = readCachedBlock(reg.url, name, opts);
    if (cached !== null) {
      const doc = parseBlockDoc(cached, url);
      slot.blocks.set(name, doc);
      return { doc, url };
    }
  }
  const doc = parseBlockDoc(await fetchJson(url, reg, opts), url);
  slot.blocks.set(name, doc);
  writeCachedBlock(reg.url, name, doc, opts);
  return { doc, url };
}

/**
 * Fetches a registry's prebuilt search-index documents (spec-08 §2).
 * `searchUrl` comes from the index and resolves against the **index** URL
 * (spec-01 §2); the fetch carries the registry's auth headers/params and the
 * permitted-URL guard like every other registry read. Lenient about shape:
 * `{ documents: [...] }` (the emitted format) or a bare array both work.
 * Never cached — it's mutable display data and callers fall back on failure.
 * @throws {RegistryError} when unreachable or not a search index
 */
export async function fetchSearchDocuments(
  reg: ResolvedRegistry,
  searchUrl: string,
  opts: FetchOptions = {},
): Promise<unknown[]> {
  const url = resolveRegistryUrl(searchUrl, reg.url);
  const body = await fetchJson(url, reg, opts);
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    const documents = (body as Record<string, unknown>).documents;
    if (Array.isArray(documents)) return documents;
  }
  throw new RegistryError(`Search index at ${url} has no documents array`);
}

/**
 * Fetches the main registry's `registries.json` directory (spec-08 §3).
 * Located via the index's `registriesUrl` when advertised, else the sibling
 * fallback (`registries.json` beside the index) — both resolved against the
 * index URL. Returns the parsed directory plus the URL it was found at.
 * @throws {RegistryError} when unreachable or malformed
 */
export async function fetchRegistriesDirectory(
  reg: ResolvedRegistry,
  opts: FetchOptions = {},
): Promise<{ directory: RegistriesDirectoryDoc; url: string }> {
  const index = await fetchIndex(reg, opts);
  const url = resolveRegistryUrl(index.registriesUrl ?? 'registries.json', reg.url);
  const directory = parseRegistriesDirectoryDoc(await fetchJson(url, reg, opts), url);
  return { directory, url };
}

/**
 * Fetches an artifact (or any registry-served file) as **raw bytes** plus the
 * URL it came from. Returning bytes — not parsed JSON — is deliberate: this
 * is the seam spec-04's digest verification hooks into (it hashes these exact
 * bytes before anything parses them). Artifacts are never cached.
 */
export async function fetchArtifact(
  url: string,
  headers: Record<string, string> = {},
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ bytes: Uint8Array; url: string }> {
  assertPermitted(url);
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers });
  } catch (err) {
    throw new RegistryError(`Could not reach ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new RegistryError(`Registry returned ${res.status} for ${url}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), url };
}

/**
 * Fetches and parses a manifest from a direct URL:
 * `fetchArtifact → computeDigest → JSON.parse → asManifest`.
 * Direct-URL installs have no registry-declared digest to compare against —
 * the digest is computed over the exact fetched bytes **here** (never
 * re-fetched later, spec-04) and recorded with the URL as `source`, so the
 * user can pin it.
 */
export async function fetchManifestFromUrl(
  url: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ manifest: Manifest; digest: string }> {
  const { bytes } = await fetchArtifact(url, {}, opts);
  const digest = computeDigest(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RegistryError(`Manifest at ${url} is not JSON`);
  }
  return { manifest: asManifest(parsed, url), digest };
}

// --- Local blocks (the authoring dev loop) ------------------------------------

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
export function readCodeDir(codeDir: string): { path: string; contents: string }[] {
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

// --- Manifest helpers ----------------------------------------------------------

/** Narrow structural check — the server does the authoritative validation. */
export function asManifest(value: unknown, source: string): Manifest {
  const manifest = value as Manifest | null;
  if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string') {
    throw new RegistryError(`Manifest at ${source} is missing a "name"`);
  }
  return manifest;
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

/** The manifest's dependency record in normalized form (`{}` for legacy/absent). */
export function dependencyRecordOf(manifest: Manifest): Record<string, string> {
  const deps: unknown = manifest.dependencies;
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return {};
  return deps as Record<string, string>;
}
