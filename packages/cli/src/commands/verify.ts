/**
 * `ion-drive block verify <ref>` — audits a published block's integrity and
 * provenance without installing anything (spec-04 §2).
 *
 *  - Registry ref (`crm`, `crm@0.2.0`, `@acme/billing@1.0.0`): fetches the
 *    registry entry + artifact **fresh** (always `noCache` — a verification
 *    tool must never trust a cache, C10), checks the digest, runs the
 *    attestation policy, and prints a verdict block: digest OK/FAIL,
 *    attestation OK/absent/FAIL(reason), computed tier, publishedAt, repo.
 *  - Direct URL / local path: no registry expectation exists — the digest is
 *    computed and printed for pinning.
 *  - `--against-installed`: additionally compares the server ledger's
 *    `artifactDigest` with the registry's digest for the installed version —
 *    catches "the registry mutated after I installed" and "someone installed
 *    something else on this server".
 *
 * Exits non-zero on a digest failure, a present-but-invalid attestation
 * bundle (unlike `add`, which proceeds — digest still protects integrity),
 * or an installed/registry digest divergence. `--json` prints one object.
 */

import semver from 'semver';
import { ApiError, type InstalledBlock, IonApiClient } from '../api-client.js';
import { ConfigError, type IonProjectConfig, readConfig } from '../config.js';
import { RefError, parseRef } from '../registry/ref.js';
import {
  type RegistryBlockDoc,
  RegistryError,
  fetchArtifact,
  fetchBlock,
  readLocalBlock,
  resolveRegistry,
  resolveRegistryUrl,
  withParams,
} from '../registry/registry-client.js';
import {
  type AttestationOutcome,
  type SigstoreVerifier,
  realSigstoreVerifier,
} from '../registry/sigstore-adapter.js';
import {
  type TierResult,
  type TrustTier,
  computeDigest,
  computeTier,
  packBytes,
  tierBadge,
} from '../registry/verify.js';
import { c, log, sym } from '../ui.js';

export interface BlockVerifyOptions {
  /** Also compare the server ledger's digest with the registry's. */
  againstInstalled?: boolean;
  /** Plain-JSON output (the LLM-first DX rule). */
  json?: boolean;
}

/** Injectable IO (tests pass fakes; production uses the real defaults). */
export interface BlockVerifyDeps {
  fetchImpl?: typeof fetch;
  verifier?: SigstoreVerifier;
  config?: IonProjectConfig;
  /** Server client override for `--against-installed`. */
  client?: Pick<IonApiClient, 'getBlock'>;
  /** Registry cache directory override (tests). */
  cacheDir?: string;
}

/** The machine-readable verdict (`--json` prints exactly this object). */
interface Verdict {
  ref: string;
  name?: string;
  version?: string;
  artifactUrl?: string;
  digest: { computed: string; expected?: string; ok: boolean };
  attestation: { status: 'ok' | 'absent' | 'invalid' | 'unavailable'; reason?: string };
  tier?: TrustTier;
  publishedAt?: string;
  repository?: string;
  installed?: {
    version: string;
    ledgerDigest: string | null;
    registryDigest?: string;
    ok: boolean;
  };
  ok: boolean;
}

export async function blockVerifyCommand(
  ref: string,
  options: BlockVerifyOptions = {},
  deps: BlockVerifyDeps = {},
): Promise<void> {
  try {
    const verdict = await buildVerdict(ref, options, deps);
    render(verdict, options);
    if (!verdict.ok) process.exitCode = 1;
  } catch (err) {
    if (
      err instanceof RefError ||
      err instanceof RegistryError ||
      err instanceof ConfigError ||
      err instanceof ApiError
    ) {
      if (options.json) console.log(JSON.stringify({ error: err.message }, null, 2));
      else log.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/** Runs the checks for whichever ref form was given. */
async function buildVerdict(
  ref: string,
  options: BlockVerifyOptions,
  deps: BlockVerifyDeps,
): Promise<Verdict> {
  const parsed = parseRef(ref);

  // URL / local: digest-only — there is no registry expectation to compare.
  if (parsed.kind === 'url') {
    const { bytes } = await fetchArtifact(parsed.url, {}, { fetchImpl: deps.fetchImpl });
    return digestOnlyVerdict(ref, computeDigest(bytes), parsed.url);
  }
  if (parsed.kind === 'local') {
    const manifest = readLocalBlock(parsed.path);
    return digestOnlyVerdict(ref, computeDigest(packBytes(manifest)), undefined, manifest.name);
  }

  return verifyRegistryRef(ref, parsed, options, deps);
}

function digestOnlyVerdict(
  ref: string,
  computed: string,
  artifactUrl?: string,
  name?: string,
): Verdict {
  return {
    ref,
    name,
    artifactUrl,
    digest: { computed, ok: true },
    attestation: { status: 'absent' },
    ok: true,
  };
}

/** The full registry path: entry → artifact → digest → attestation → ledger. */
async function verifyRegistryRef(
  ref: string,
  parsed: { namespace?: string; name: string; selector?: string },
  options: BlockVerifyOptions,
  deps: BlockVerifyDeps,
): Promise<Verdict> {
  const config = deps.config ?? readConfig();
  const reg = resolveRegistry(parsed.namespace, config);
  // ALWAYS fresh — a verification tool must never trust the metadata cache.
  const { doc, url: blockUrl } = await fetchBlock(reg, parsed.name, {
    noCache: true,
    fetchImpl: deps.fetchImpl,
    cacheDir: deps.cacheDir,
  });

  const version = pickVersion(doc, parsed.selector);
  const entry = doc.versions[version];
  if (!entry) throw new RegistryError(`"${parsed.name}" has no version ${version}`); // unreachable
  const artifactUrl = resolveRegistryUrl(entry.artifactUrl, blockUrl);

  const { bytes } = await fetchArtifact(withParams(artifactUrl, reg.params), reg.headers, {
    fetchImpl: deps.fetchImpl,
  });
  const computed = computeDigest(bytes);
  const sizeOk = entry.size === undefined || bytes.byteLength === entry.size;
  const digestOk = computed === entry.digest && sizeOk;

  const tier = await attestationTier(entry.attestationUrl, blockUrl, reg, computed, doc, deps);

  const verdict: Verdict = {
    ref,
    name: parsed.name,
    version,
    artifactUrl,
    digest: { computed, expected: entry.digest, ok: digestOk },
    attestation: { status: tier.attestationStatus, reason: tier.reason },
    tier: tier.tier,
    publishedAt: entry.publishedAt,
    repository: doc.repository,
    ok: digestOk && tier.attestationStatus !== 'invalid',
  };

  if (options.againstInstalled) {
    verdict.installed = await compareInstalled(parsed.name, doc, config, deps);
    verdict.ok = verdict.ok && verdict.installed.ok;
  }
  return verdict;
}

/** Exact selector (must exist) else the registry's `latest`. */
function pickVersion(doc: RegistryBlockDoc, selector: string | undefined): string {
  if (selector === undefined) return doc.latest;
  if (selector in doc.versions) return selector;
  if (semver.valid(selector) === null) {
    throw new RegistryError(
      `verify takes an exact version — "${selector}" is a range. Published versions: ${Object.keys(doc.versions).sort().join(', ')}`,
    );
  }
  throw new RegistryError(
    `"${doc.name}" has no version ${selector}. Published: ${Object.keys(doc.versions).sort().join(', ')}`,
  );
}

/** Fetches + verifies the bundle (when present) and computes the tier. */
async function attestationTier(
  attestationUrl: string | undefined,
  blockUrl: string,
  reg: { headers: Record<string, string>; params: Record<string, string> },
  computedDigest: string,
  doc: RegistryBlockDoc,
  deps: BlockVerifyDeps,
): Promise<TierResult> {
  let outcome: AttestationOutcome | undefined;
  if (attestationUrl) {
    const url = resolveRegistryUrl(attestationUrl, blockUrl);
    try {
      const { bytes } = await fetchArtifact(withParams(url, reg.params), reg.headers, {
        fetchImpl: deps.fetchImpl,
      });
      const bundleJson = JSON.parse(new TextDecoder().decode(bytes));
      outcome = await (deps.verifier ?? realSigstoreVerifier()).verifyBundle(bundleJson);
    } catch (err) {
      outcome = { kind: 'unavailable', reason: (err as Error).message };
    }
  }
  return computeTier({ computedDigest, repository: doc.repository, attestation: outcome });
}

/** `--against-installed`: ledger digest vs registry digest for that version. */
async function compareInstalled(
  name: string,
  doc: RegistryBlockDoc,
  config: IonProjectConfig,
  deps: BlockVerifyDeps,
): Promise<NonNullable<Verdict['installed']>> {
  const client = deps.client ?? new IonApiClient(config.serverUrl, config.apiKey);
  let installed: InstalledBlock;
  try {
    installed = await client.getBlock(name);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(`"${name}" is not installed on ${config.serverUrl}`, 404);
    }
    throw err;
  }
  const ledgerDigest = installed.artifactDigest ?? null;
  const registryDigest = doc.versions[installed.version]?.digest;
  // Divergence only when both sides have a digest to compare; a null ledger
  // digest (pre-spec-04 install) is reported but not failed.
  const ok =
    ledgerDigest === null || registryDigest === undefined || ledgerDigest === registryDigest;
  return { version: installed.version, ledgerDigest, registryDigest, ok };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(verdict: Verdict, options: BlockVerifyOptions): void {
  if (options.json) {
    console.log(JSON.stringify(verdict, null, 2));
    return;
  }
  log.raw();
  const title = verdict.version ? `${verdict.name}@${verdict.version}` : verdict.ref;
  log.raw(
    `${sym.satellite} ${c.bold(title)}${verdict.artifactUrl ? c.dim(`  ${verdict.artifactUrl}`) : ''}`,
  );

  renderDigestLine(verdict);
  renderAttestationLine(verdict);
  if (verdict.tier) {
    log.raw(`  ${sym.dot} tier        ${tierBadge(verdict.tier, verdict.repository)}`);
  }
  if (verdict.publishedAt) log.raw(`  ${sym.dot} published   ${verdict.publishedAt}`);
  if (verdict.repository) log.raw(`  ${sym.dot} repository  ${verdict.repository}`);
  renderInstalledLine(verdict);
  log.raw();
  if (verdict.ok) log.success('Verification passed.');
  else log.error('Verification FAILED — see above.');
}

function renderDigestLine(verdict: Verdict): void {
  if (verdict.digest.expected === undefined) {
    log.raw(
      `  ${sym.dot} digest      ${c.cyan(verdict.digest.computed)} ${c.dim('(computed — no registry expectation; pin this)')}`,
    );
    return;
  }
  if (verdict.digest.ok) {
    log.raw(`  ${sym.check} digest      ${c.success('OK')} ${c.dim(verdict.digest.computed)}`);
    return;
  }
  log.raw(`  ${sym.cross} digest      ${c.danger('FAIL')}`);
  log.raw(`      expected ${verdict.digest.expected}`);
  log.raw(`      actual   ${verdict.digest.computed}`);
  log.raw(
    `      ${c.danger('The registry or artifact host may be compromised, or the publisher mutated a released version.')}`,
  );
}

function renderAttestationLine(verdict: Verdict): void {
  const { status, reason } = verdict.attestation;
  if (status === 'ok') log.raw(`  ${sym.check} attestation ${c.success('OK')}`);
  else if (status === 'absent') log.raw(`  ${sym.dot} attestation ${c.meteor('absent')}`);
  else if (status === 'unavailable') {
    log.raw(`  ${sym.warn} attestation ${c.warn(`unavailable${reason ? ` (${reason})` : ''}`)}`);
  } else {
    log.raw(`  ${sym.cross} attestation ${c.danger(`FAIL${reason ? ` (${reason})` : ''}`)}`);
  }
}

function renderInstalledLine(verdict: Verdict): void {
  const installed = verdict.installed;
  if (!installed) return;
  if (installed.ok) {
    const note =
      installed.ledgerDigest === null
        ? c.dim('(server ledger has no digest — pre-spec-04 install)')
        : c.dim(installed.ledgerDigest);
    log.raw(`  ${sym.check} installed   ${c.success('matches')} v${installed.version} ${note}`);
    return;
  }
  log.raw(`  ${sym.cross} installed   ${c.danger('DIVERGES')} — server has v${installed.version}`);
  log.raw(`      ledger   ${installed.ledgerDigest}`);
  log.raw(`      registry ${installed.registryDigest ?? '(version not in registry)'}`);
  log.raw(
    `      ${c.danger('The registry mutated after this install, or this server installed different bytes.')}`,
  );
}
