/**
 * Artifact integrity + trust-tier policy (spec-04).
 *
 * Everything here is pure `node:crypto` — no network, no filesystem — so the
 * whole security decision surface is unit-testable with byte fixtures:
 *
 *  - **Digest**: `sha256:<hex>` over the *exact artifact bytes* (spec-04 §1;
 *    no canonicalization — artifacts are published once and never
 *    regenerated). {@link verifyDigest} is the hard gate every registry
 *    install passes through *before* JSON.parse, vendoring, or POSTing.
 *    It deliberately takes **no force parameter** — a poisoned artifact is
 *    never "forced" (suite rule 6).
 *  - **Trust tiers** ({@link computeTier}): `official`/`verified`/`community`
 *    computed client-side from the attestation outcome — never taken from a
 *    registry's self-asserted `trust` field (that is a display hint only).
 *  - **{@link packBytes}** renders a manifest to the exact bytes `ion-drive
 *    block pack` writes, so a locally computed digest equals the digest of
 *    the published artifact built from the same manifest.
 */

import { createHash } from 'node:crypto';
import type { AttestationOutcome } from './sigstore-adapter.js';

/**
 * Thrown when artifact bytes fail the digest/size gate. Callers abort the
 * ENTIRE operation (never just the failing block) and never offer a
 * `--force` escape — see spec-04 §2 / AC1.
 */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

/** The GitHub Actions OIDC issuer a `verified` attestation must come from. */
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

/** Repos whose verified blocks are `official` (overridable for tests). */
export const OFFICIAL_REPOS = ['jaredgrabill/ion-drive-blocks'];

export type TrustTier = 'official' | 'verified' | 'community';

/** How the attestation check for one artifact concluded. */
export type AttestationStatus = 'ok' | 'absent' | 'invalid' | 'unavailable';

/** `sha256:<hex>` over the exact bytes. */
export function computeDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The hard integrity gate: compares the computed digest of `bytes` with the
 * registry-declared one.
 * @throws {IntegrityError} on mismatch, with the documented message (spec-04 §2)
 */
export function verifyDigest(bytes: Uint8Array, expected: string, artifactUrl: string): void {
  const actual = computeDigest(bytes);
  if (actual === expected) return;
  throw new IntegrityError(
    `Artifact digest mismatch for ${artifactUrl}\n  expected: ${expected}\n  actual:   ${actual}\nThe registry or artifact host may be compromised, or the publisher mutated a released version. Installation aborted — this check cannot be overridden.`,
  );
}

/**
 * Pre-parse size sanity/DoS guard: when the registry entry declared a `size`,
 * the fetched byte count must match. (A streaming download cap — refusing to
 * buffer past the declared size — is future hardening; today artifacts are
 * small and fully buffered.)
 * @throws {IntegrityError} on mismatch (same hard failure as a digest mismatch)
 */
export function checkSize(
  bytes: Uint8Array,
  expectedSize: number | undefined,
  artifactUrl: string,
): void {
  if (expectedSize === undefined || bytes.byteLength === expectedSize) return;
  throw new IntegrityError(
    `Artifact size mismatch for ${artifactUrl}\n  expected: ${expectedSize} bytes\n  actual:   ${bytes.byteLength} bytes\nThe registry or artifact host may be compromised, or the publisher mutated a released version. Installation aborted — this check cannot be overridden.`,
  );
}

/**
 * Normalizes a repository reference to lowercase `owner/repo`. Accepts
 * `https://github.com/owner/repo(.git)`, `github.com/owner/repo`, and bare
 * `owner/repo`; anything else (other hosts, malformed) yields `null` — which
 * always fails a repo-match check, the safe default.
 */
export function normalizeRepo(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\.git$/i, '');
  const match =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i.exec(trimmed) ??
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

/**
 * Renders a manifest to the exact artifact bytes `ion-drive block pack`
 * emits (pretty-printed JSON + trailing newline). Shared by `pack` and the
 * local-path digest computation so the two can never drift.
 */
export function packBytes(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** Input to {@link computeTier} — everything the policy needs, nothing more. */
export interface TierInput {
  /** The digest WE computed over the fetched bytes (never the registry's claim). */
  computedDigest: string;
  /** The per-block file's `repository` field, when set. */
  repository?: string;
  /** The attestation outcome; `undefined` = no bundle was checked (absent/skipped). */
  attestation?: AttestationOutcome;
  /** Override for the official-repo constant (tests). */
  officialRepos?: string[];
}

export interface TierResult {
  tier: TrustTier;
  attestationStatus: AttestationStatus;
  /** Why the attestation did not upgrade the tier (invalid/unavailable detail). */
  reason?: string;
}

/**
 * The spec-04 §3 decision table. A version is `verified` iff the bundle
 * verified cryptographically AND its subject digest equals the digest we
 * computed AND the certificate's OIDC issuer is GitHub Actions AND the
 * certificate's source repository matches the registry's `repository` claim
 * (which must be set). `official` = verified from an official repo.
 * Everything else is `community`.
 */
export function computeTier(input: TierInput): TierResult {
  const { attestation } = input;
  if (!attestation) return { tier: 'community', attestationStatus: 'absent' };
  if (attestation.kind === 'unavailable') {
    return { tier: 'community', attestationStatus: 'unavailable', reason: attestation.reason };
  }
  if (attestation.kind === 'invalid') {
    return { tier: 'community', attestationStatus: 'invalid', reason: attestation.reason };
  }

  const failure = verifiedTierFailure(input, attestation.facts);
  if (failure) return { tier: 'community', attestationStatus: 'invalid', reason: failure };

  const repo = normalizeRepo(input.repository);
  const officialRepos = (input.officialRepos ?? OFFICIAL_REPOS).map((r) => normalizeRepo(r));
  const tier: TrustTier = repo !== null && officialRepos.includes(repo) ? 'official' : 'verified';
  return { tier, attestationStatus: 'ok' };
}

/** The first policy condition a cryptographically-valid bundle fails, if any. */
function verifiedTierFailure(
  input: TierInput,
  facts: { subjectDigests: string[]; issuer?: string; sourceRepository?: string },
): string | null {
  const computedHex = input.computedDigest.replace(/^sha256:/, '');
  if (!facts.subjectDigests.includes(computedHex)) {
    return 'attestation subject digest does not match the artifact we downloaded';
  }
  if (facts.issuer !== GITHUB_ACTIONS_ISSUER) {
    return `attestation OIDC issuer is ${facts.issuer ?? '(none)'} — expected ${GITHUB_ACTIONS_ISSUER}`;
  }
  if (!input.repository) {
    return 'registry entry has no repository field to match the attestation against';
  }
  const claimed = normalizeRepo(input.repository);
  const attested = normalizeRepo(facts.sourceRepository);
  if (claimed === null || attested === null || claimed !== attested) {
    return `attestation source repository ${facts.sourceRepository ?? '(none)'} does not match the registry's ${input.repository}`;
  }
  return null;
}

/**
 * The plain-text trust badge for plan lines / list rows / verify verdicts
 * (spec-04 §3 table). Callers colorize; this stays pure.
 */
export function tierBadge(tier: TrustTier, repository?: string): string {
  if (tier === 'official') return '◆ official';
  if (tier === 'verified') {
    const repo = normalizeRepo(repository);
    return repo ? `✔ verified · github.com/${repo}` : '✔ verified';
  }
  return '○ community (unattested)';
}
