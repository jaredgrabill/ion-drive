/**
 * Unit tests for the sigstore adapter seam: pure bundle shape-parsing against
 * the hand-built fixtures in `__fixtures__/bundles.ts` (subjects, Fulcio
 * extension claims, malformed-bundle classification) and the outcome
 * classification of `realSigstoreVerifier` with the library mocked — a
 * network/TUF failure must degrade to `unavailable` (AC7), a cryptographic
 * failure to `invalid`, and neither may throw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFixtureBundle,
  corruptPayloadBundle,
  missingEnvelopeBundle,
} from './__fixtures__/bundles.js';
import { extractBundleFacts, realSigstoreVerifier } from './sigstore-adapter.js';

const HEX = 'a'.repeat(64);
const ISSUER = 'https://token.actions.githubusercontent.com';
const REPO = 'https://github.com/acme/blocks';

const goodBundle = () =>
  buildFixtureBundle({
    subjectSha256: HEX,
    issuer: ISSUER,
    sourceRepository: REPO,
    sourceCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  });

describe('extractBundleFacts (shape parsing on fixtures)', () => {
  it('extracts subjects, issuer, source repository and commit', () => {
    const facts = extractBundleFacts(goodBundle());
    expect(facts.subjectDigests).toEqual([HEX]);
    expect(facts.issuer).toBe(ISSUER);
    expect(facts.sourceRepository).toBe(REPO);
    expect(facts.sourceCommit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  });

  it('omits claims the certificate does not carry', () => {
    const facts = extractBundleFacts(buildFixtureBundle({ subjectSha256: HEX, issuer: ISSUER }));
    expect(facts.issuer).toBe(ISSUER);
    expect(facts.sourceRepository).toBeUndefined();
    expect(facts.sourceCommit).toBeUndefined();
  });

  it('throws for corrupted payloads and missing envelopes', () => {
    expect(() => extractBundleFacts(corruptPayloadBundle({ subjectSha256: HEX }))).toThrow();
    expect(() => extractBundleFacts(missingEnvelopeBundle({ subjectSha256: HEX }))).toThrow(
      /dsseEnvelope/,
    );
    expect(() => extractBundleFacts(null)).toThrow(/not a JSON object/);
    expect(() => extractBundleFacts('nope')).toThrow();
  });
});

// --- realSigstoreVerifier classification (library mocked) ----------------------

vi.mock('sigstore', () => ({ verify: vi.fn() }));

async function mockedVerify() {
  const sigstore = await import('sigstore');
  return vi.mocked(sigstore.verify);
}

afterEach(() => vi.clearAllMocks());

describe('realSigstoreVerifier', () => {
  it('returns verified with extracted facts when the library accepts the bundle', async () => {
    (await mockedVerify()).mockResolvedValue(undefined as never);
    const outcome = await realSigstoreVerifier().verifyBundle(goodBundle());
    expect(outcome.kind).toBe('verified');
    if (outcome.kind === 'verified') {
      expect(outcome.facts.subjectDigests).toEqual([HEX]);
      expect(outcome.facts.issuer).toBe(ISSUER);
    }
  });

  it('classifies TUF/network failures as unavailable — degrade, never crash (AC7)', async () => {
    (await mockedVerify()).mockRejectedValue(
      new Error('request to https://tuf-repo-cdn.sigstore.dev failed: getaddrinfo ENOTFOUND'),
    );
    const outcome = await realSigstoreVerifier().verifyBundle(goodBundle());
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') expect(outcome.reason).toContain('unavailable');
  });

  it('classifies signature/chain failures as invalid', async () => {
    (await mockedVerify()).mockRejectedValue(new Error('signature verification failed'));
    const outcome = await realSigstoreVerifier().verifyBundle(goodBundle());
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') expect(outcome.reason).toContain('signature');
  });

  it('classifies a malformed bundle as invalid without touching the library', async () => {
    const verify = await mockedVerify();
    const outcome = await realSigstoreVerifier().verifyBundle({ nope: true });
    expect(outcome.kind).toBe('invalid');
    expect(verify).not.toHaveBeenCalled();
  });
});
