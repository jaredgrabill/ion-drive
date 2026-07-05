/**
 * Registry client — resolves block manifests from a source.
 *
 * Two sources are supported, mirroring shadcn's registry model:
 *  - **bundled** — the official catalog shipped in `@ionshift/ion-drive-blocks` (offline,
 *    the default), used for `list` and by-name `add`.
 *  - **remote URL** — any `http(s)://…/block.json`, so third-party/self-hosted
 *    registries work without code changes (the `registryDependencies`-by-URL
 *    analog). A bare name hits the bundled catalog; a URL is fetched.
 *
 * The client stays dumb about *installing* — it only produces validated-enough
 * manifest objects; the server performs the authoritative Zod validation on
 * install.
 */

import { type BlockSummary, blockSummaries, getBlock } from '@ionshift/ion-drive-blocks';

/** A manifest is an opaque object here; the server validates it on install. */
export type Manifest = Record<string, unknown> & { name: string; dependencies?: string[] };

export class RegistryError extends Error {}

/** Lists the bundled catalog's summaries (for `ion-drive list`). */
export function listAvailable(): BlockSummary[] {
  return blockSummaries;
}

/** True when `ref` looks like a remote registry URL rather than a bare name. */
export function isUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/** Resolves a single manifest by bare name (bundled) or URL (remote). */
export async function getManifest(ref: string): Promise<Manifest> {
  if (isUrl(ref)) return fetchManifest(ref);

  const manifest = getBlock(ref);
  if (!manifest) {
    const known = blockSummaries.map((b) => b.name).join(', ');
    throw new RegistryError(`Unknown block "${ref}". Available: ${known}`);
  }
  return manifest as unknown as Manifest;
}

/** Fetches and parses a remote `block.json`. */
async function fetchManifest(url: string): Promise<Manifest> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new RegistryError(`Could not reach registry at ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new RegistryError(`Registry returned ${res.status} for ${url}`);
  }
  const manifest = (await res.json()) as Manifest;
  if (!manifest?.name) {
    throw new RegistryError(`Manifest at ${url} is missing a "name"`);
  }
  return manifest;
}

/** Normalises a manifest's declared dependencies to a string array. */
export function dependenciesOf(manifest: Manifest): string[] {
  return Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
}
