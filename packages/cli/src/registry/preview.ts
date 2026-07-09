/**
 * The shared resolve-and-verify pipeline behind `ion-drive add` and the
 * registry MCP's `preview_install` tool (spec-08 §4 / AC4 — one code path,
 * asserted by a parity test).
 *
 * Pure and UI-free (no spinners, no chalk, no stdout): the command layer owns
 * rendering/confirmation, the MCP layer owns JSON-ification. Two pieces:
 *
 *  - {@link gatherServerState} — the server-side facts planning needs
 *    (installed blocks, core version) plus the local config's recorded
 *    blocks (the yanked exact-reinstall exception).
 *  - {@link buildVerifiedPlan} — parse the ref → resolve the dependency
 *    closure ({@link resolvePlan}) → run the spec-04 **verify phase**
 *    ({@link fetchAndVerifyPlan}, extracted verbatim from `commands/add.ts`):
 *    every registry artifact is fetched as raw bytes and its sha256 checked
 *    against the registry-declared digest before anything else happens. A
 *    digest mismatch aborts the whole plan with no `--force` override
 *    (spec-04 AC1). Attestation bundles verify through the sigstore seam and
 *    produce the `official`/`verified`/`community` tier per item.
 */

import type { IonApiClient } from '../api-client.js';
import type { InstalledBlockRecord, IonProjectConfig } from '../config.js';
import { type ParsedRef, parseRef } from './ref.js';
import {
  type Manifest,
  RegistryError,
  asManifest,
  fetchArtifact,
  fetchBlock,
  fetchIndex,
  fetchManifestFromUrl,
  readLocalBlock,
  resolveRegistry,
  withParams,
} from './registry-client.js';
import { type InstallPlan, type PlanItem, type ResolverIO, resolvePlan } from './resolver.js';
import {
  type AttestationOutcome,
  type SigstoreVerifier,
  realSigstoreVerifier,
} from './sigstore-adapter.js';
import {
  type AttestationStatus,
  type TrustTier,
  checkSize,
  computeDigest,
  computeTier,
  normalizeRepo,
  packBytes,
  verifyDigest,
} from './verify.js';

// ---------------------------------------------------------------------------
// Verify phase (spec-04 §2 — extracted from commands/add.ts, behavior intact)
// ---------------------------------------------------------------------------

/** One plan item after the verify phase — manifest in hand, tier computed. */
export interface VerifiedItem {
  item: PlanItem;
  manifest: Manifest;
  /** The digest computed over the actual bytes (what the ledger records). */
  computedDigest: string;
  tier: TrustTier;
  attestationStatus: AttestationStatus;
  /** Set when the attestation verified: who built it, at which commit. */
  attestedBy?: { repository: string; commit?: string };
  /** Verify-phase notices, rendered under the plan line. */
  warnings: string[];
}

/** Injectable IO for the verify phase (tests pass fakes; prod uses defaults). */
export interface VerifyPhaseDeps {
  fetchImpl?: typeof fetch;
  verifier?: SigstoreVerifier;
}

/**
 * The spec-04 verify phase: fetches every registry item's artifact bytes,
 * enforces size + digest (hard failure — `IntegrityError` aborts the whole
 * plan; no flag is even consulted), parses the manifest from the verified
 * bytes, and runs the attestation policy when a bundle is present. Local/URL
 * items reuse the digest computed at planning time — their bytes are never
 * re-fetched (C8).
 */
export async function fetchAndVerifyPlan(
  items: PlanItem[],
  config: IonProjectConfig,
  opts: { verifyProvenance: boolean } & VerifyPhaseDeps = { verifyProvenance: true },
): Promise<VerifiedItem[]> {
  const verifier = opts.verifier ?? realSigstoreVerifier();
  const verified: VerifiedItem[] = [];
  for (const item of items) {
    verified.push(
      item.manifest
        ? verifyManifestItem(item, item.manifest)
        : await verifyRegistryItem(item, config, { ...opts, verifier }),
    );
  }
  return verified;
}

/** Local/URL items: the manifest + digest are already in hand from planning. */
function verifyManifestItem(item: PlanItem, manifest: Manifest): VerifiedItem {
  const computedDigest = item.digest ?? computeDigest(packBytes(manifest));
  const warnings: string[] = [];
  if (item.source !== 'local') {
    warnings.push(
      `installed from a direct URL — computed ${computedDigest}. Pin this by re-adding from a registry, or keep this digest for your records.`,
    );
  }
  return {
    item,
    manifest,
    computedDigest,
    tier: 'community',
    attestationStatus: 'absent',
    warnings,
  };
}

/** Registry items: fetch bytes → size gate → digest gate → parse → attest. */
async function verifyRegistryItem(
  item: PlanItem,
  config: IonProjectConfig,
  opts: { verifyProvenance: boolean; fetchImpl?: typeof fetch; verifier: SigstoreVerifier },
): Promise<VerifiedItem> {
  if (!item.registry || !item.sourceUrl || !item.digest) {
    throw new RegistryError(`Plan item "${item.name}" has no artifact source`); // unreachable
  }
  const reg = resolveRegistry(item.registry, config);
  const { bytes } = await fetchArtifact(withParams(item.sourceUrl, reg.params), reg.headers, {
    fetchImpl: opts.fetchImpl,
  });
  // The two hard gates. IntegrityError aborts the ENTIRE command — deliberately
  // no force parameter exists on this path (spec-04 AC1).
  checkSize(bytes, item.size, item.sourceUrl);
  verifyDigest(bytes, item.digest, item.sourceUrl);
  const computedDigest = item.digest; // proven equal to sha256(bytes) above

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RegistryError(`Artifact at ${item.sourceUrl} is not JSON`);
  }
  const manifest = asManifest(parsed, item.sourceUrl);

  const { outcome, warnings } = await checkAttestation(item, reg, opts);
  const tierResult = computeTier({
    computedDigest,
    repository: item.repository,
    attestation: outcome,
  });
  appendTierWarnings(warnings, tierResult.attestationStatus, tierResult.reason);

  const attestedBy =
    tierResult.attestationStatus === 'ok' && outcome?.kind === 'verified'
      ? {
          repository: normalizeRepo(outcome.facts.sourceRepository) ?? '',
          commit: outcome.facts.sourceCommit,
        }
      : undefined;
  return {
    item,
    manifest,
    computedDigest,
    tier: tierResult.tier,
    attestationStatus: tierResult.attestationStatus,
    attestedBy,
    warnings,
  };
}

/** Fetches + verifies the attestation bundle, when present and not skipped. */
async function checkAttestation(
  item: PlanItem,
  reg: { headers: Record<string, string>; params: Record<string, string> },
  opts: { verifyProvenance: boolean; fetchImpl?: typeof fetch; verifier: SigstoreVerifier },
): Promise<{ outcome?: AttestationOutcome; warnings: string[] }> {
  if (!item.attestationUrl) return { warnings: [] };
  if (!opts.verifyProvenance) {
    return { warnings: ['provenance check skipped (--no-verify-provenance)'] };
  }
  let bundleJson: unknown;
  try {
    const { bytes } = await fetchArtifact(
      withParams(item.attestationUrl, reg.params),
      reg.headers,
      {
        fetchImpl: opts.fetchImpl,
      },
    );
    bundleJson = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    // A missing/unreachable bundle degrades, never crashes (AC7): the digest
    // already protects integrity; attestation is provenance.
    return {
      outcome: { kind: 'unavailable', reason: (err as Error).message },
      warnings: [],
    };
  }
  return { outcome: await opts.verifier.verifyBundle(bundleJson), warnings: [] };
}

/** The one warning line each non-verified outcome earns (spec-04 UX rules). */
function appendTierWarnings(
  warnings: string[],
  status: AttestationStatus,
  reason: string | undefined,
): void {
  if (status === 'absent' && warnings.length === 0) {
    warnings.push('unattested — install proceeds on digest integrity alone');
  } else if (status === 'invalid') {
    warnings.push(
      `attestation present but INVALID — treat as unattested; this can indicate tampering${reason ? ` (${reason})` : ''}`,
    );
  } else if (status === 'unavailable') {
    warnings.push(
      `could not verify provenance${reason ? ` (${reason})` : ''} — treating as community`,
    );
  }
}

// ---------------------------------------------------------------------------
// The shared plan builder (spec-08 §4)
// ---------------------------------------------------------------------------

/** The server/config facts planning consumes. */
export interface ServerState {
  /** Installed blocks on the server: name → version. */
  installed: Map<string, string>;
  /** The local config's `blocks[]` (the yanked exact-reinstall exception). */
  recordedBlocks: InstalledBlockRecord[];
  /** The server's core version (from `/health`) for `requires.core` warnings. */
  serverCoreVersion?: string;
}

/**
 * Collects {@link ServerState} from a running server + the local config.
 * Throws `ApiError` when the server is unreachable — `add` fails hard there;
 * `preview_install` catches and previews with empty state (documented
 * divergence: a preview is still useful without a server).
 */
export async function gatherServerState(
  client: IonApiClient,
  config: IonProjectConfig,
): Promise<ServerState> {
  const health = await client.health();
  const installed = new Map(
    (await client.listInstalled())
      .filter((b) => b.status === 'installed')
      .map((b) => [b.name, b.version] as const),
  );
  return { installed, recordedBlocks: config.blocks, serverCoreVersion: health.version };
}

/** {@link ServerState} for an unreachable server (preview-only callers). */
export function emptyServerState(config: IonProjectConfig): ServerState {
  return { installed: new Map(), recordedBlocks: config.blocks };
}

export interface VerifiedPlan {
  /** The parsed root ref (kind + name/url/path). */
  ref: ParsedRef;
  plan: InstallPlan;
  /** Plan items after the verify phase, in install order. */
  verified: VerifiedItem[];
}

export interface BuildVerifiedPlanOptions extends VerifyPhaseDeps {
  serverState: ServerState;
  /** `add --force` semantics (never touches the digest gate). */
  force?: boolean;
  /** Bypass registry metadata cache reads. */
  noCache?: boolean;
  /** Default true; false = `--no-verify-provenance`. */
  verifyProvenance?: boolean;
}

/**
 * The one pipeline both `add` and `preview_install` run: parse → resolve →
 * verify. Throws the registry layer's typed errors (`RefError`,
 * `ResolveError`, `RegistryError`, `IntegrityError`, `ConfigError`) — the
 * caller translates them for its surface.
 */
export async function buildVerifiedPlan(
  target: string,
  config: IonProjectConfig,
  opts: BuildVerifiedPlanOptions,
): Promise<VerifiedPlan> {
  const fetchOpts = { noCache: opts.noCache === true, fetchImpl: opts.fetchImpl };
  const io: ResolverIO = {
    fetchIndex: (reg) => fetchIndex(reg, fetchOpts),
    fetchBlock: (reg, name) => fetchBlock(reg, name, fetchOpts),
    getLocalOrUrlManifest: async (ref) => {
      if (ref.kind === 'url') return fetchManifestFromUrl(ref.url, { fetchImpl: opts.fetchImpl });
      // Local blocks: the digest is computed over the packed bytes the CLI
      // itself assembles — identical to what `block pack` would publish.
      const manifest = readLocalBlock(ref.path);
      return { manifest, digest: computeDigest(packBytes(manifest)) };
    },
  };

  const ref = parseRef(target);
  const plan = await resolvePlan(ref, {
    config,
    installed: opts.serverState.installed,
    recordedBlocks: opts.serverState.recordedBlocks,
    serverCoreVersion: opts.serverState.serverCoreVersion,
    force: opts.force,
    io,
  });
  const verified =
    plan.items.length === 0
      ? []
      : await fetchAndVerifyPlan(plan.items, config, {
          verifyProvenance: opts.verifyProvenance !== false,
          fetchImpl: opts.fetchImpl,
          verifier: opts.verifier,
        });
  return { ref, plan, verified };
}
