/**
 * Registry HTTP client for the blocks browser — thin fetch layer over the
 * vendored protocol reader, with the failure classification the degradation
 * matrix needs:
 *
 *  - the index unreachable ⇒ `RegistryOfflineError` (the full offline notice;
 *    the rest of the site is unaffected),
 *  - the index readable but unusable (legacy format, future schemaVersion,
 *    malformed) ⇒ `RegistryError` with the reader's exact message,
 *  - per-block / search-index / readme / registries failures are *partial*:
 *    callers degrade section-by-section, never the whole page.
 *
 * The registry base URL is fixed at build time via `PUBLIC_REGISTRY_URL`
 * (defaults to the official registry) so tests and previews can point the
 * browser at a local fixture registry (http is permitted on localhost only).
 */

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
} from './reader.js';

/** The registry index could not be reached at all (network / non-2xx). */
export class RegistryOfflineError extends Error {
  constructor(url: string, cause?: unknown) {
    super(`registry unreachable at ${url}${cause instanceof Error ? ` (${cause.message})` : ''}`);
    this.name = 'RegistryOfflineError';
  }
}

export const DEFAULT_REGISTRY_URL = 'https://registry.iondrive.dev/registry/index.json';

/** The build-time registry index URL (`PUBLIC_REGISTRY_URL` override). */
export function getRegistryUrl(): string {
  const fromEnv = import.meta.env?.PUBLIC_REGISTRY_URL as string | undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_REGISTRY_URL;
}

/** Permitted-URL-guarded fetch returning parsed JSON; non-2xx throws. */
async function fetchJson(url: string): Promise<unknown> {
  if (!isPermittedRegistryUrl(url)) {
    throw new RegistryError(`refusing to fetch non-https registry URL: ${url}`);
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

/**
 * Fetches + parses the registry index. Network failure ⇒ `RegistryOfflineError`;
 * an unusable document (legacy, future version, malformed) ⇒ `RegistryError`.
 */
export async function loadIndex(indexUrl: string): Promise<RegistryIndexDoc> {
  let raw: unknown;
  try {
    raw = await fetchJson(indexUrl);
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    throw new RegistryOfflineError(indexUrl, err);
  }
  return parseIndexDoc(raw, indexUrl);
}

/** Fetches + parses one `blocks/<name>.json`, resolved against the index URL. */
export async function loadBlock(
  index: RegistryIndexDoc,
  indexUrl: string,
  name: string,
): Promise<{ doc: RegistryBlockDoc; blockUrl: string }> {
  const entry = index.blocks[name];
  if (!entry) throw new RegistryError(`"${name}" is not listed in this registry`);
  const blockUrl = resolveRegistryUrl(entry.blockUrl, indexUrl);
  const doc = parseBlockDoc(await fetchJson(blockUrl), blockUrl);
  return { doc, blockUrl };
}

/**
 * Fetches the prebuilt search index advertised by `searchUrl` (spec-08) and
 * lenient-parses it: `{ documents: [...] }` or a bare array both work. Any
 * failure throws — the caller warns and falls back to index substring search
 * (the exact CLI posture).
 */
export async function loadSearchDocuments(
  index: RegistryIndexDoc,
  indexUrl: string,
): Promise<unknown[]> {
  if (index.searchUrl === undefined) throw new RegistryError('index advertises no searchUrl');
  const url = resolveRegistryUrl(index.searchUrl, indexUrl);
  const raw = await fetchJson(url);
  if (Array.isArray(raw)) return raw;
  if (
    typeof raw === 'object' &&
    raw !== null &&
    Array.isArray((raw as { documents?: unknown }).documents)
  ) {
    return (raw as { documents: unknown[] }).documents;
  }
  throw new RegistryError(`${url}: search index has no documents array`);
}

/**
 * Fetches the registries directory: from `registriesUrl` when advertised,
 * else probing the index's sibling `registries.json`. Returns `null` when
 * neither yields a usable document (the browser shows an empty state).
 */
export async function loadRegistriesDirectory(
  index: RegistryIndexDoc,
  indexUrl: string,
): Promise<RegistriesDirectoryDoc | null> {
  const candidate = index.registriesUrl ?? 'registries.json';
  const url = resolveRegistryUrl(candidate, indexUrl);
  try {
    return parseRegistriesDirectoryDoc(await fetchJson(url), url);
  } catch {
    return null;
  }
}

/**
 * Fetches a block's copied README markdown (spec-08 `readmeUrl`). Returns
 * `null` when the block advertises none or the fetch fails — the README
 * section is simply omitted.
 */
export async function loadReadme(doc: RegistryBlockDoc, blockUrl: string): Promise<string | null> {
  if (doc.readmeUrl === undefined) return null;
  const url = resolveRegistryUrl(doc.readmeUrl, blockUrl);
  if (!isPermittedRegistryUrl(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
