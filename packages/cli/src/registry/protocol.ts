/**
 * Registry protocol v1 — the CLI's *consumer-side* reader (spec-03 §3).
 *
 * This is a deliberately **lenient** counterpart to core's strict Zod schemas
 * (`packages/core/src/blocks/registry-types.ts`, spec-01): it validates only
 * what the CLI actually depends on and tolerates unknown fields, so a registry
 * can evolve additively without breaking installed CLIs. Strictness is the
 * publisher's job (`ion-drive registry build`, spec-05 — which validates with
 * core's schemas). What *is* enforced here:
 *
 * - The **format gate**: `schemaVersion` must be literal `1`. A missing
 *   `schemaVersion` on an index means the pre-release unversioned format
 *   (clean break, suite rule 5) and gets spec-01's exact "ask its owner to run
 *   `ion-drive registry build`" message; any other value is a future protocol
 *   this client can't read.
 * - The load-bearing fields: index `name`/`generatedAt`/`blocks` with
 *   `latest` + `blockUrl` per entry; block-file `name`/`latest`/`versions`
 *   with `artifactUrl` + `digest` per version; the `latest ∈ versions` and
 *   `yanked ⇒ yankedAt` cross-field rules.
 *
 * The types here are narrow local shapes (the CLI has no runtime dependency
 * on core — see `ref.ts`); a parity test feeds the same fixture registry to
 * both core's parsers and this reader.
 */

/** Thrown for anything a registry serves that this client cannot consume. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

// --- Narrow consumer types ---------------------------------------------------

/** One summary entry in `index.json`'s `blocks` map. */
export interface RegistryIndexEntry {
  title?: string;
  description?: string;
  categories?: string[];
  /** Latest published version. */
  latest: string;
  /** URL of the per-block version file, relative to the index or absolute. */
  blockUrl: string;
  /** Display hint only — real trust is computed client-side (spec-04). */
  trust?: string;
}

/** `index.json` — the registry directory. */
export interface RegistryIndexDoc {
  schemaVersion: 1;
  name: string;
  description?: string;
  homepage?: string;
  generatedAt: string;
  /** Prebuilt search-index URL (spec-08), relative to the index or absolute. */
  searchUrl?: string;
  /** `registries.json` directory URL (spec-08); absent ⇒ probe the index's sibling. */
  registriesUrl?: string;
  blocks: Record<string, RegistryIndexEntry>;
}

export type RegistryVersionStatus = 'active' | 'deprecated' | 'yanked';

/** One published version in a `blocks/<name>.json` history. */
export interface RegistryVersionEntry {
  /** The immutable artifact — relative to the block file, or absolute. */
  artifactUrl: string;
  /** `sha256:<hex>` over the exact artifact bytes (verified by spec-04). */
  digest: string;
  size?: number;
  publishedAt?: string;
  /** Mirror of the manifest's `dependencies` (name → semver range). */
  dependencies: Record<string, string>;
  /** Mirror of manifest `requires` — at minimum `core` when declared. */
  requires: { core?: string } & Record<string, unknown>;
  attestationUrl?: string;
  status: RegistryVersionStatus;
  statusReason?: string;
  yankedAt?: string;
}

/** A security advisory (consumed by `ion-drive audit`, spec-06 — carried, not read here). */
export interface RegistryAdvisory {
  id: string;
  severity: string;
  affectedVersions: string;
  description: string;
  url?: string;
  createdAt: string;
}

/** `blocks/<name>.json` — a block's full version history. */
export interface RegistryBlockDoc {
  schemaVersion: 1;
  name: string;
  title?: string;
  description?: string;
  categories?: string[];
  repository?: string;
  homepage?: string;
  /** Copied-README URL (spec-08), relative to this file or absolute. Display data. */
  readmeUrl?: string;
  latest: string;
  versions: Record<string, RegistryVersionEntry>;
  advisories: RegistryAdvisory[];
}

/** One entry in a `registries.json` directory (spec-01 §6, consumer view). */
export interface RegistriesDirectoryEntry {
  /** The `@handle` projects map to this registry's URL. */
  namespace: string;
  /** Absolute URL of the registry's `index.json`. */
  url: string;
  owner?: string;
  description?: string;
  repository?: string;
  /** `listed` means "reviewed for listing", not "code audited". Display only. */
  trust?: string;
}

/** `registries.json` — the PR-reviewed directory of registries. */
export interface RegistriesDirectoryDoc {
  schemaVersion: 1;
  registries: RegistriesDirectoryEntry[];
}

// --- Format gate -------------------------------------------------------------

/** Spec-01's exact rejection for the pre-release (unversioned) index format. */
export const LEGACY_INDEX_MESSAGE =
  'registry is in the pre-release unversioned format — ask its owner to run `ion-drive registry build`';

/**
 * Rejects anything but `schemaVersion: 1`. `kind` decides the missing-field
 * message: a versionless *index* is the known pre-release format; a
 * versionless block file is just malformed.
 */
function checkFormatGate(record: Record<string, unknown>, url: string, kind: 'index' | 'block') {
  if (!('schemaVersion' in record)) {
    if (kind === 'index') throw new RegistryError(`${url}: ${LEGACY_INDEX_MESSAGE}`);
    throw new RegistryError(`${url}: registry block file is missing schemaVersion`);
  }
  if (record.schemaVersion !== 1) {
    throw new RegistryError(
      `${url}: this registry uses an unsupported format (schemaVersion ${JSON.stringify(
        record.schemaVersion,
      )}; this client supports schemaVersion 1)`,
    );
  }
}

// --- Lenient parsers -----------------------------------------------------------

function asRecord(input: unknown, url: string, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RegistryError(`${url}: ${what} is not a JSON object`);
  }
  return input as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, url: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RegistryError(`${url}: missing or invalid "${field}"`);
  }
  return value;
}

/**
 * Validates a fetched `index.json`. Lenient: unknown fields pass through;
 * only the format gate + load-bearing fields are checked.
 * @throws {RegistryError}
 */
export function parseIndexDoc(input: unknown, url: string): RegistryIndexDoc {
  const record = asRecord(input, url, 'registry index');
  checkFormatGate(record, url, 'index');
  requireString(record, 'name', url);
  requireString(record, 'generatedAt', url);
  const blocks = asRecord(record.blocks ?? {}, url, 'registry index "blocks"');
  for (const [name, raw] of Object.entries(blocks)) {
    const entry = asRecord(raw, url, `index entry "${name}"`);
    requireString(entry, 'latest', url);
    requireString(entry, 'blockUrl', url);
  }
  return record as unknown as RegistryIndexDoc;
}

/**
 * Validates a fetched `blocks/<name>.json`, including the cross-field rules
 * (`latest ∈ versions`, `yanked ⇒ yankedAt`). Lenient about everything else;
 * absent `dependencies`/`requires`/`advisories` default to empty.
 * @throws {RegistryError}
 */
export function parseBlockDoc(input: unknown, url: string): RegistryBlockDoc {
  const record = asRecord(input, url, 'registry block file');
  checkFormatGate(record, url, 'block');
  const name = requireString(record, 'name', url);
  const latest = requireString(record, 'latest', url);
  const versions = asRecord(record.versions ?? {}, url, `versions of "${name}"`);

  for (const [version, raw] of Object.entries(versions)) {
    const entry = asRecord(raw, url, `version "${version}" of "${name}"`);
    requireString(entry, 'artifactUrl', url);
    requireString(entry, 'digest', url);
    // Lenient defaults for the fields resolution reads.
    if (typeof entry.dependencies !== 'object' || entry.dependencies === null) {
      entry.dependencies = {};
    }
    if (typeof entry.requires !== 'object' || entry.requires === null) entry.requires = {};
    if (entry.status === undefined) entry.status = 'active';
    if (entry.status === 'yanked' && typeof entry.yankedAt !== 'string') {
      throw new RegistryError(
        `${url}: version "${version}" of "${name}" is yanked but has no yankedAt`,
      );
    }
  }

  if (!(latest in versions)) {
    throw new RegistryError(`${url}: latest "${latest}" of "${name}" is not a key of versions`);
  }
  if (!Array.isArray(record.advisories)) record.advisories = [];
  return record as unknown as RegistryBlockDoc;
}

/**
 * Validates a fetched `registries.json` (spec-08 §3). Lenient beyond the
 * format gate and the load-bearing `namespace`/`url` pair per entry; entries
 * missing either are skipped rather than fatal (one bad listing must not take
 * the whole directory down).
 * @throws {RegistryError}
 */
export function parseRegistriesDirectoryDoc(input: unknown, url: string): RegistriesDirectoryDoc {
  const record = asRecord(input, url, 'registries directory');
  if (!('schemaVersion' in record)) {
    throw new RegistryError(`${url}: registries directory is missing schemaVersion`);
  }
  if (record.schemaVersion !== 1) {
    throw new RegistryError(
      `${url}: this registries directory uses an unsupported format (schemaVersion ${JSON.stringify(
        record.schemaVersion,
      )}; this client supports schemaVersion 1)`,
    );
  }
  if (!Array.isArray(record.registries)) {
    throw new RegistryError(`${url}: registries directory has no "registries" array`);
  }
  const registries: RegistriesDirectoryEntry[] = [];
  for (const raw of record.registries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.namespace !== 'string' || typeof entry.url !== 'string') continue;
    registries.push(entry as unknown as RegistriesDirectoryEntry);
  }
  return { schemaVersion: 1, registries };
}

// --- URL helpers (vendored from core's registry-types.ts — keep identical) ----

/**
 * Resolves a URL found inside a registry file against the URL of the file it
 * appears in (spec-01 §2). Relative URLs — including `../../` traversal — are
 * legal: this is URL space, not filesystem space. Absolute URLs pass through.
 */
export function resolveRegistryUrl(url: string, containingFileUrl: string): string {
  return new URL(url, containingFileUrl).toString();
}

/**
 * Whether clients may fetch a registry/artifact URL: `https:` always; `http:`
 * only for `localhost`/`127.0.0.1` (local dev); everything else — including
 * `file:` — is rejected. Non-parseable input is rejected too.
 */
export function isPermittedRegistryUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  }
  return false;
}
