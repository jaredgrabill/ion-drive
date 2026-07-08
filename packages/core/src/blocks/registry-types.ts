/**
 * Block registry protocol v1 — wire-format schemas + parse helpers (ADR-022 / spec-01).
 *
 * A registry is a set of static JSON files served over HTTPS: a small
 * `index.json` directory (name → summary + `latest` + `blockUrl`), one
 * `blocks/<name>.json` per block carrying the full version history (the
 * resolution + trust root), and — on the main registry only — an optional
 * `registries.json` directory of other registries. This module is the single
 * source of truth for those three shapes: the CLI, `registry build`, the site
 * generator, and the hosted service all validate with these schemas, and the
 * published JSON Schema files are generated from them (see
 * `registry-json-schemas.ts`, drift-guarded by a unit test).
 *
 * Protocol semantics the schemas encode (spec-01 Design §5):
 *
 * - **Immutability** — once published, a `(name, version)` entry's
 *   `artifactUrl`, `digest`, `size`, `publishedAt`, `dependencies`,
 *   `requires`, and `attestationUrl` never change, and the artifact bytes at
 *   `artifactUrl` never change. Fixing anything means publishing a new
 *   version. Mutable by design: `latest`, per-version
 *   `status`/`statusReason`/`yankedAt`, top-level `advisories`, and display
 *   metadata.
 * - **Status** — `active` (normal), `deprecated` (installable, clients warn),
 *   `yanked` (never *selected* for a range or `latest`; exact re-installs of a
 *   version already recorded in the project stay allowed; always warned).
 * - **Malware exception** — a registry MAY delete a malicious artifact
 *   outright (the URL 404s), but MUST simultaneously mark the version
 *   `yanked` and publish an advisory, so consumers see a loud, explicable
 *   failure instead of silently installing malware.
 * - **Advisories** — every field except `url` is required: an advisory that
 *   cannot say what it affects, how bad it is, and when it was issued is
 *   useless to `ion-drive audit` and the resolver's warnings.
 * - **Directory entries** — `namespace` and `url` are the load-bearing pair
 *   (a namespace is a *source*, not an identity); `trust: "listed"` means
 *   exactly "reviewed for listing", not "code audited".
 *
 * Parsing follows the {@link parseManifest} style from `block-manifest.ts`:
 * Zod first, then cross-field checks the schema can't express, everything
 * aggregated into a {@link RegistryParseError} with readable issues.
 */

import semver from 'semver';
import { z } from 'zod';

// --- Shared format schemas -------------------------------------------------

/** A canonical semver version — exactly what `semver.valid` normalises to. */
const semverStringSchema = z.string().refine((v) => semver.valid(v) === v, {
  message: 'must be a canonical semver version (e.g. "0.2.0")',
});

/** A semver range expression (`^1.2`, `>=0.2.0 <1.0.0`, `1.x`, …). */
const semverRangeSchema = z.string().refine((v) => semver.validRange(v) !== null, {
  message: 'must be a valid semver range (e.g. ">=0.2.0 <1.0.0")',
});

/** `sha256:` + 64 lowercase hex chars over the exact artifact bytes (spec-04). */
const digestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'must be "sha256:" followed by 64 lowercase hex characters');

/** ISO-8601 UTC timestamp (`Z` suffix required — the protocol's timestamps are UTC). */
const isoUtcSchema = z.string().datetime({
  message: 'must be an ISO-8601 UTC timestamp (e.g. "2026-07-08T00:00:00Z")',
});

/**
 * Block-name record keys — the manifest `name` grammar. Deliberately
 * duplicated from `block-types.ts` (`blockManifestSchema.name`): spec-02
 * unifies the two under a shared export; until then this module must not
 * reach into the manifest schema it treats as opaque.
 */
const blockNameKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'must be lowercase kebab/snake case');

// --- index.json ------------------------------------------------------------

/**
 * One summary entry in the index's `blocks` map. `latest` and `blockUrl` are
 * the only load-bearing fields; the rest is display. The index carries no
 * version lists and no digests — that's the per-block file's job (Helm's
 * monolithic `index.yaml` scaling failure is the anti-pattern).
 */
const registryIndexEntrySchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    categories: z.array(z.string()).optional(),
    /** Latest published version — a canonical semver string. */
    latest: semverStringSchema,
    /** URL of the per-block version file, relative to the index or absolute https. */
    blockUrl: z.string().min(1),
    /** Display hint only; third-party values are ignored (spec-04 computes real trust). */
    trust: z.literal('official').optional(),
  })
  .strict();

/** `index.json` — the registry directory: name → summary + latest (for list/search). */
export const registryIndexSchema = z
  .object({
    $schema: z.string().optional(),
    /** Protocol version. Clients reject anything but literal `1`. */
    schemaVersion: z.literal(1),
    /** Registry display name (shown by `ion-drive registry list` and the site). */
    name: z.string().min(1),
    description: z.string().optional(),
    homepage: z.string().optional(),
    /** Regenerated on every build — cache-busting signal and staleness display. */
    generatedAt: isoUtcSchema,
    /** Summary per block. Required, may be empty. Keys use the manifest name grammar. */
    blocks: z.record(blockNameKeySchema, registryIndexEntrySchema),
  })
  .strict();

// --- blocks/<name>.json ----------------------------------------------------

/**
 * Lifecycle status of a published version.
 * - `active` — normal.
 * - `deprecated` — resolvable and installable; clients warn.
 * - `yanked` — resolvers MUST refuse to *select* it (never chosen for a range
 *   or `latest`), MUST allow exact re-installs of a version already recorded
 *   in the project's `ion.config.json`, and always warn. Requires `yankedAt`.
 */
const registryVersionStatusSchema = z.enum(['active', 'deprecated', 'yanked']);

/** Advisory severity, as consumed by `ion-drive audit` (spec-06). */
const advisorySeveritySchema = z.enum(['low', 'moderate', 'high', 'critical']);

/**
 * One immutable published version. Everything except `status`,
 * `statusReason`, and `yankedAt` never changes after publication (§5).
 */
const registryVersionEntrySchema = z
  .object({
    /** The immutable artifact — relative to the containing file, or absolute https. */
    artifactUrl: z.string().min(1),
    /** sha256 over the exact artifact bytes; verified before vendoring/installing. */
    digest: digestSchema,
    /** Artifact byte length (pre-download sanity + UX). */
    size: z.number().int().nonnegative(),
    /** The protocol's timestamp of record. */
    publishedAt: isoUtcSchema,
    /**
     * Mirror of the manifest's `dependencies` (name → semver range, spec-02)
     * so resolvers plan the closure without fetching artifacts. Required, may
     * be empty.
     */
    dependencies: z.record(blockNameKeySchema, semverRangeSchema),
    /**
     * Mirror of manifest `requires` — at minimum `core` (semver range) when
     * declared; may include `handlers`/`plugins` counts or lists for display,
     * hence the open catchall. Required, may be `{}`.
     */
    requires: z.object({ core: semverRangeSchema.optional() }).catchall(z.unknown()),
    /** Sigstore bundle adjacent to the artifact. Absent ⇒ unattested (community tier). */
    attestationUrl: z.string().min(1).optional(),
    status: registryVersionStatusSchema,
    /** Human context for `deprecated`/`yanked`. */
    statusReason: z.string().optional(),
    /** Required when `status` is `yanked` (cross-field check). */
    yankedAt: isoUtcSchema.optional(),
  })
  .strict();

/** A security advisory against a range of versions (top-level, mutable). */
const registryAdvisorySchema = z
  .object({
    /** Registry-scoped advisory id (e.g. `IONB-2026-0001`). */
    id: z.string().min(1),
    severity: advisorySeveritySchema,
    /** Semver range of affected versions. */
    affectedVersions: semverRangeSchema,
    description: z.string().min(1),
    url: z.string().url().optional(),
    createdAt: isoUtcSchema,
  })
  .strict();

/** `blocks/<name>.json` — a block's full version history: the resolution + trust root. */
export const registryBlockSchema = z
  .object({
    $schema: z.string().optional(),
    /** Protocol version. Clients reject anything but literal `1`. */
    schemaVersion: z.literal(1),
    /** Block name — the manifest name grammar. */
    name: blockNameKeySchema,
    title: z.string().optional(),
    description: z.string().optional(),
    categories: z.array(z.string()).optional(),
    /** Source repository — also the claim attestations are verified against (spec-04). */
    repository: z.string().url().optional(),
    homepage: z.string().url().optional(),
    /** Must be a key of `versions` (cross-field check). */
    latest: semverStringSchema,
    /** Version history, keyed by canonical semver version. */
    versions: z.record(semverStringSchema, registryVersionEntrySchema),
    advisories: z.array(registryAdvisorySchema).default([]),
  })
  .strict();

// --- registries.json -------------------------------------------------------

/** One entry in the main registry's directory of other registries. */
const registryDirectoryEntrySchema = z
  .object({
    /**
     * The `@handle` projects map to this registry's URL — the namespace half
     * of spec-02's `blockRefSchema` grammar (`@acme/billing@^1.2`).
     */
    namespace: z.string().regex(/^@[a-z][a-z0-9-]*$/, 'must be like "@acme" (lowercase kebab)'),
    /** Absolute URL of the registry's `index.json`. */
    url: z.string().url(),
    owner: z.string().optional(),
    description: z.string().optional(),
    repository: z.string().url().optional(),
    /** `listed` means exactly "reviewed for listing", not "code audited". */
    trust: z.enum(['official', 'listed']).optional(),
  })
  .strict();

/** `registries.json` — the PR-reviewed directory of registries (main registry only). */
export const registriesDirectorySchema = z
  .object({
    $schema: z.string().optional(),
    /** Protocol version. Clients reject anything but literal `1`. */
    schemaVersion: z.literal(1),
    registries: z.array(registryDirectoryEntrySchema),
  })
  .strict();

// --- Inferred types ----------------------------------------------------------

export type RegistryIndex = z.infer<typeof registryIndexSchema>;
export type RegistryIndexEntry = z.infer<typeof registryIndexEntrySchema>;
export type RegistryBlock = z.infer<typeof registryBlockSchema>;
export type RegistryVersionEntry = z.infer<typeof registryVersionEntrySchema>;
export type RegistryVersionStatus = z.infer<typeof registryVersionStatusSchema>;
export type RegistryAdvisory = z.infer<typeof registryAdvisorySchema>;
export type AdvisorySeverity = z.infer<typeof advisorySeveritySchema>;
export type RegistriesDirectory = z.infer<typeof registriesDirectorySchema>;
export type RegistryDirectoryEntry = z.infer<typeof registryDirectoryEntrySchema>;

// --- Parse helpers -----------------------------------------------------------

/** Thrown by the parse helpers; `issues` carries the aggregated readable problems. */
export class RegistryParseError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'RegistryParseError';
  }
}

/**
 * Validates a raw `index.json` value. A legacy (pre-release, unversioned)
 * index and any non-1 `schemaVersion` are rejected with actionable messages
 * before Zod runs, so users see "upgrade the registry", not a wall of issues.
 * @throws {RegistryParseError}
 */
export function parseRegistryIndex(input: unknown): RegistryIndex {
  rejectUnsupportedFormat(input, { legacyIndex: true });
  const parsed = registryIndexSchema.safeParse(input);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw new RegistryParseError(`Invalid registry index: ${issues.join('; ')}`, issues);
  }
  return parsed.data;
}

/**
 * Validates a raw `blocks/<name>.json` value, including the cross-field
 * checks the schema can't express (`latest` ∈ `versions`, yanked ⇒ `yankedAt`).
 * @throws {RegistryParseError}
 */
export function parseRegistryBlock(input: unknown): RegistryBlock {
  rejectUnsupportedFormat(input);
  const parsed = registryBlockSchema.safeParse(input);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw new RegistryParseError(`Invalid registry block: ${issues.join('; ')}`, issues);
  }

  const block = parsed.data;
  const issues = checkBlockConsistency(block);
  if (issues.length > 0) {
    throw new RegistryParseError(
      `Invalid registry block "${block.name}": ${issues.join('; ')}`,
      issues,
    );
  }
  return block;
}

/**
 * Validates a raw `registries.json` value.
 * @throws {RegistryParseError}
 */
export function parseRegistriesDirectory(input: unknown): RegistriesDirectory {
  rejectUnsupportedFormat(input);
  const parsed = registriesDirectorySchema.safeParse(input);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw new RegistryParseError(`Invalid registries directory: ${issues.join('; ')}`, issues);
  }
  return parsed.data;
}

/**
 * Pre-Zod format gate. A missing `schemaVersion` on an index means the
 * pre-release unversioned format (clean break, no compat code — suite rule 5);
 * any present-but-not-1 value means a future protocol this client can't read.
 */
function rejectUnsupportedFormat(input: unknown, opts: { legacyIndex?: boolean } = {}): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return; // let Zod report
  const record = input as Record<string, unknown>;

  if (!('schemaVersion' in record)) {
    if (opts.legacyIndex) {
      throw new RegistryParseError(
        'registry is in the pre-release unversioned format — ask its owner to run `ion-drive registry build`',
      );
    }
    return; // per-block/directory files: let Zod report the missing literal
  }

  if (record.schemaVersion !== 1) {
    throw new RegistryParseError(
      `this registry uses an unsupported format (schemaVersion ${JSON.stringify(
        record.schemaVersion,
      )}; this client supports schemaVersion 1)`,
    );
  }
}

/** Cross-field checks for a per-block file, aggregated `checkConsistency`-style. */
function checkBlockConsistency(block: RegistryBlock): string[] {
  const issues: string[] = [];

  if (!(block.latest in block.versions)) {
    issues.push(`latest "${block.latest}" is not a key of versions`);
  }

  for (const [version, entry] of Object.entries(block.versions)) {
    if (entry.status === 'yanked' && entry.yankedAt === undefined) {
      issues.push(`version "${version}" is yanked but has no yankedAt`);
    }
  }

  return issues;
}

/**
 * Turns a ZodError into a flat list of `path: message` strings. (Duplicated
 * from `block-manifest.ts`, where it is module-private.)
 */
function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

// --- URL helpers -------------------------------------------------------------

/**
 * Resolves a URL found inside a registry file against the URL of the file it
 * appears in (spec-01 §2). Relative URLs — including `../../` traversal — are
 * legal: this is URL space, not filesystem space, and traversal is how the
 * reference layout points from `registry/blocks/<name>.json` back to
 * `<name>/dist/<version>/block.json`. Absolute URLs pass through unchanged.
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
