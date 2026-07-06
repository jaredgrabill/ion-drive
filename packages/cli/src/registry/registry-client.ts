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
 * The bundled catalog is loaded lazily and is **optional** (a devDependency —
 * present in the monorepo, absent from the published CLI). This is the interim
 * Phase 14 Tier 0 state: blocks are moving to their own repos + a registry
 * index (Tier 4, ADR-018 amendment), at which point the bundled path retires
 * entirely. Without the catalog, URL resolution still works.
 *
 * The client stays dumb about *installing* — it only produces validated-enough
 * manifest objects; the server performs the authoritative Zod validation on
 * install.
 */

/** A manifest is an opaque object here; the server validates it on install. */
export type Manifest = Record<string, unknown> & { name: string; dependencies?: string[] };

/** Summary shape of a catalog entry (mirrors @ionshift/ion-drive-blocks). */
export interface BlockSummary {
  name: string;
  title: string;
  description: string;
  version: string;
  author?: string;
  categories: string[];
  dependencies: string[];
  icon?: string;
  objectCount: number;
}

/** The slice of the bundled-catalog module the client consumes. */
interface BundledCatalog {
  blockSummaries: BlockSummary[];
  getBlock: (name: string) => unknown;
}

export class RegistryError extends Error {}

/**
 * Loads the optional bundled catalog once. Returns null when
 * `@ionshift/ion-drive-blocks` is not installed (the published-CLI case).
 */
let catalogPromise: Promise<BundledCatalog | null> | undefined;
async function loadBundledCatalog(): Promise<BundledCatalog | null> {
  catalogPromise ??= import('@ionshift/ion-drive-blocks').then(
    (mod) => mod as unknown as BundledCatalog,
    () => null,
  );
  return catalogPromise;
}

/** Lists the bundled catalog's summaries (for `ion-drive list`). */
export async function listAvailable(): Promise<BlockSummary[]> {
  const catalog = await loadBundledCatalog();
  return catalog?.blockSummaries ?? [];
}

/** True when `ref` looks like a remote registry URL rather than a bare name. */
export function isUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/** Resolves a single manifest by bare name (bundled) or URL (remote). */
export async function getManifest(ref: string): Promise<Manifest> {
  if (isUrl(ref)) return fetchManifest(ref);

  const catalog = await loadBundledCatalog();
  if (!catalog) {
    throw new RegistryError(
      'The bundled block catalog is not installed — reference blocks by URL, or install @ionshift/ion-drive-blocks.',
    );
  }
  const manifest = catalog.getBlock(ref);
  if (!manifest) {
    const known = catalog.blockSummaries.map((b) => b.name).join(', ');
    throw new RegistryError(`Unknown block "${ref}". Available: ${known}`);
  }
  return manifest as Manifest;
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
