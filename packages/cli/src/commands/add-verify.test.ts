/**
 * Unit tests for `add`'s verify phase (`fetchAndVerifyPlan`, spec-04 §2):
 * the digest hard-gate aborts the whole plan with no partial results (AC1),
 * digest-first ordering beats attestation (AC3), tier/warning behavior for
 * absent/invalid/unavailable bundles (AC2/AC7), and the local/URL digest
 * reuse from planning (C8) — all over an injected fetchImpl + fake verifier,
 * no network, no sigstore.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IonProjectConfig } from '../config.js';
import type { PlanItem } from '../registry/resolver.js';
import type { AttestationOutcome, SigstoreVerifier } from '../registry/sigstore-adapter.js';
import { GITHUB_ACTIONS_ISSUER, IntegrityError, computeDigest } from '../registry/verify.js';
import { fetchAndVerifyPlan } from './add.js';

const MAIN_URL = 'https://main.test/registry/index.json';
const ARTIFACT_URL = 'https://main.test/crm/dist/0.2.0/block.json';
const BUNDLE_URL = 'https://main.test/crm/dist/0.2.0/block.json.sigstore.json';
const OFFICIAL_REPO = 'https://github.com/jaredgrabill/ion-drive-blocks';

const config: IonProjectConfig = {
  serverUrl: 'http://localhost:3000',
  blocks: [],
  registries: { '@main': MAIN_URL },
  defaultRegistry: '@main',
};

const artifactBytes = new TextEncoder().encode(
  JSON.stringify({ name: 'crm', version: '0.2.0', title: 'CRM' }),
);
const artifactDigest = computeDigest(artifactBytes);
const artifactHex = artifactDigest.replace('sha256:', '');

function registryItem(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    name: 'crm',
    version: '0.2.0',
    source: '@main',
    registry: '@main',
    sourceUrl: ARTIFACT_URL,
    digest: artifactDigest,
    isDependency: false,
    warnings: [],
    ...overrides,
  };
}

/** fetchImpl serving byte bodies per URL; anything else 404s. */
function byteFetch(routes: Record<string, Uint8Array | object>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = routes[url];
    if (body === undefined) return new Response('nope', { status: 404 });
    const payload: ConstructorParameters<typeof Response>[0] =
      body instanceof Uint8Array ? body : JSON.stringify(body);
    return new Response(payload, { status: 200 });
  }) as typeof fetch;
}

/** {@link byteFetch} wrapped in a call-counting spy. */
function spyByteFetch(routes: Record<string, Uint8Array | object>) {
  return vi.fn(byteFetch(routes)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function fakeVerifier(outcome: AttestationOutcome): SigstoreVerifier & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async verifyBundle(bundleJson) {
      calls.push(bundleJson);
      return outcome;
    },
  };
}

const verifiedOutcome = (subjectHex: string, repo = OFFICIAL_REPO): AttestationOutcome => ({
  kind: 'verified',
  facts: {
    subjectDigests: [subjectHex],
    issuer: GITHUB_ACTIONS_ISSUER,
    sourceRepository: repo,
    sourceCommit: 'a1b2c3d4e5f6',
  },
});

describe('fetchAndVerifyPlan — the digest gate (AC1)', () => {
  it('a tampered artifact throws IntegrityError with the documented message', async () => {
    // One byte flipped: the served bytes differ from what the digest pins.
    const flipped = Uint8Array.from(artifactBytes);
    flipped[0] = flipped[0] === 0x7b ? 0x5b : 0x7b;
    const fetchImpl = byteFetch({ [ARTIFACT_URL]: flipped });

    const err = await fetchAndVerifyPlan([registryItem()], config, {
      verifyProvenance: true,
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect(err.message).toContain(ARTIFACT_URL);
    expect(err.message).toContain(`expected: ${artifactDigest}`);
    expect(err.message).toContain('may be compromised');
  });

  it('aborts the ENTIRE plan — a later good item is never processed', async () => {
    const goodBytes = new TextEncoder().encode(JSON.stringify({ name: 'other' }));
    const fetchSpy = spyByteFetch({
      [ARTIFACT_URL]: new TextEncoder().encode('tampered'),
      'https://main.test/other/dist/1.0.0/block.json': goodBytes,
    });
    const items = [
      registryItem(),
      registryItem({
        name: 'other',
        version: '1.0.0',
        sourceUrl: 'https://main.test/other/dist/1.0.0/block.json',
        digest: computeDigest(goodBytes),
      }),
    ];
    await expect(
      fetchAndVerifyPlan(items, config, { verifyProvenance: true, fetchImpl: fetchSpy }),
    ).rejects.toThrow(IntegrityError);
    // Only the first (tampered) artifact was ever fetched — no partial results.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a declared-size mismatch is the same hard failure', async () => {
    const fetchImpl = byteFetch({ [ARTIFACT_URL]: artifactBytes });
    await expect(
      fetchAndVerifyPlan([registryItem({ size: artifactBytes.byteLength + 1 })], config, {
        verifyProvenance: true,
        fetchImpl,
      }),
    ).rejects.toThrow(IntegrityError);
  });
});

describe('fetchAndVerifyPlan — digest before attestation (AC3)', () => {
  it('registry lies about the digest but the bundle matches the artifact ⇒ digest throws first', async () => {
    const verifier = fakeVerifier(verifiedOutcome(artifactHex));
    const fetchImpl = byteFetch({
      [ARTIFACT_URL]: artifactBytes,
      [BUNDLE_URL]: { any: 'bundle' },
    });
    await expect(
      fetchAndVerifyPlan(
        [
          registryItem({
            digest: `sha256:${'0'.repeat(64)}`, // the lie
            attestationUrl: BUNDLE_URL,
            repository: OFFICIAL_REPO,
          }),
        ],
        config,
        { verifyProvenance: true, fetchImpl, verifier },
      ),
    ).rejects.toThrow(IntegrityError);
    expect(verifier.calls).toHaveLength(0); // never reached the attestation step
  });

  it('registry digest matches but the bundle subject differs ⇒ invalid/community, add proceeds', async () => {
    const verifier = fakeVerifier(verifiedOutcome('b'.repeat(64))); // wrong subject
    const fetchImpl = byteFetch({ [ARTIFACT_URL]: artifactBytes, [BUNDLE_URL]: { any: 'bundle' } });
    const [v] = await fetchAndVerifyPlan(
      [registryItem({ attestationUrl: BUNDLE_URL, repository: OFFICIAL_REPO })],
      config,
      { verifyProvenance: true, fetchImpl, verifier },
    );
    expect(v?.tier).toBe('community');
    expect(v?.attestationStatus).toBe('invalid');
    expect(v?.warnings.some((w) => w.includes('INVALID'))).toBe(true);
  });
});

describe('fetchAndVerifyPlan — tiers and warnings (AC2/AC7)', () => {
  it('valid artifact + valid bundle + official repo ⇒ official, no warnings', async () => {
    const verifier = fakeVerifier(verifiedOutcome(artifactHex));
    const fetchImpl = byteFetch({ [ARTIFACT_URL]: artifactBytes, [BUNDLE_URL]: { any: 'bundle' } });
    const [v] = await fetchAndVerifyPlan(
      [registryItem({ attestationUrl: BUNDLE_URL, repository: OFFICIAL_REPO })],
      config,
      { verifyProvenance: true, fetchImpl, verifier },
    );
    expect(v?.tier).toBe('official');
    expect(v?.attestationStatus).toBe('ok');
    expect(v?.attestedBy?.repository).toBe('jaredgrabill/ion-drive-blocks');
    expect(v?.warnings).toEqual([]);
    expect(v?.computedDigest).toBe(artifactDigest);
    expect(v?.manifest.name).toBe('crm');
  });

  it('third-party repo match ⇒ verified', async () => {
    const repo = 'https://github.com/acme/blocks';
    const verifier = fakeVerifier(verifiedOutcome(artifactHex, repo));
    const fetchImpl = byteFetch({ [ARTIFACT_URL]: artifactBytes, [BUNDLE_URL]: { any: 'bundle' } });
    const [v] = await fetchAndVerifyPlan(
      [registryItem({ attestationUrl: BUNDLE_URL, repository: repo })],
      config,
      { verifyProvenance: true, fetchImpl, verifier },
    );
    expect(v?.tier).toBe('verified');
  });

  it('absent bundle ⇒ community with exactly one warning line', async () => {
    const fetchImpl = byteFetch({ [ARTIFACT_URL]: artifactBytes });
    const [v] = await fetchAndVerifyPlan([registryItem()], config, {
      verifyProvenance: true,
      fetchImpl,
    });
    expect(v?.tier).toBe('community');
    expect(v?.attestationStatus).toBe('absent');
    expect(v?.warnings).toHaveLength(1);
    expect(v?.warnings[0]).toContain('unattested');
  });

  it('unavailable verifier outcome ⇒ community + warning, add completes (AC7)', async () => {
    const verifier = fakeVerifier({ kind: 'unavailable', reason: 'TUF root unreachable' });
    const fetchImpl = byteFetch({ [ARTIFACT_URL]: artifactBytes, [BUNDLE_URL]: { any: 'bundle' } });
    const [v] = await fetchAndVerifyPlan(
      [registryItem({ attestationUrl: BUNDLE_URL, repository: OFFICIAL_REPO })],
      config,
      { verifyProvenance: true, fetchImpl, verifier },
    );
    expect(v?.tier).toBe('community');
    expect(v?.attestationStatus).toBe('unavailable');
    expect(v?.warnings.some((w) => w.includes('TUF root unreachable'))).toBe(true);
  });

  it('an unreachable bundle URL degrades to unavailable, never crashes (AC7)', async () => {
    const verifier = fakeVerifier(verifiedOutcome(artifactHex));
    const fetchImpl = byteFetch({ [ARTIFACT_URL]: artifactBytes }); // bundle 404s
    const [v] = await fetchAndVerifyPlan(
      [registryItem({ attestationUrl: BUNDLE_URL, repository: OFFICIAL_REPO })],
      config,
      { verifyProvenance: true, fetchImpl, verifier },
    );
    expect(v?.tier).toBe('community');
    expect(v?.attestationStatus).toBe('unavailable');
    expect(verifier.calls).toHaveLength(0);
  });

  it('--no-verify-provenance skips the bundle but NEVER the digest', async () => {
    const verifier = fakeVerifier(verifiedOutcome(artifactHex));
    const fetchSpy = spyByteFetch({ [ARTIFACT_URL]: artifactBytes });
    const [v] = await fetchAndVerifyPlan(
      [registryItem({ attestationUrl: BUNDLE_URL, repository: OFFICIAL_REPO })],
      config,
      { verifyProvenance: false, fetchImpl: fetchSpy, verifier },
    );
    expect(v?.tier).toBe('community');
    expect(verifier.calls).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // artifact only, no bundle fetch
    expect(v?.warnings[0]).toContain('--no-verify-provenance');
    // …and the tampered case still throws with the flag set:
    await expect(
      fetchAndVerifyPlan([registryItem({ digest: `sha256:${'0'.repeat(64)}` })], config, {
        verifyProvenance: false,
        fetchImpl: fetchSpy,
      }),
    ).rejects.toThrow(IntegrityError);
  });
});

describe('fetchAndVerifyPlan — local/URL items (C8)', () => {
  it('a URL item reuses the planning-time digest and earns the pin message', async () => {
    const manifest = { name: 'solo', version: '1.0.0' };
    const item: PlanItem = {
      name: 'solo',
      version: '1.0.0',
      source: 'https://x.test/block.json',
      sourceUrl: 'https://x.test/block.json',
      manifest,
      digest: `sha256:${'d'.repeat(64)}`,
      isDependency: false,
      warnings: [],
    };
    const fetchSpy = spyByteFetch({});
    const [v] = await fetchAndVerifyPlan([item], config, {
      verifyProvenance: true,
      fetchImpl: fetchSpy,
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // bytes are NEVER re-fetched
    expect(v?.computedDigest).toBe(`sha256:${'d'.repeat(64)}`);
    expect(v?.warnings.some((w) => w.includes('keep this digest for your records'))).toBe(true);
  });

  it('a local item is quiet — no unattested warning', async () => {
    const manifest = { name: 'mine', version: '0.1.0' };
    const item: PlanItem = {
      name: 'mine',
      version: '0.1.0',
      source: 'local',
      manifest,
      digest: `sha256:${'e'.repeat(64)}`,
      isDependency: false,
      warnings: [],
    };
    const [v] = await fetchAndVerifyPlan([item], config, { verifyProvenance: true });
    expect(v?.warnings).toEqual([]);
    expect(v?.tier).toBe('community');
  });
});
