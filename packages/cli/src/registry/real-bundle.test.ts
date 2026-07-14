/**
 * Real-attestation fixtures (spec-04 §"generate real attestation fixtures").
 *
 * `__fixtures__/audit-0.1.2.block.json` + `.sigstore.json` are the EXACT bytes
 * of the first attested publish from `jaredgrabill/ion-drive-blocks`
 * (`publish: audit@0.1.2`, attest commit e6f8ef9, 2026-07-14) — real Fulcio
 * certificate, real Rekor entry, not the hand-built shapes in
 * `__fixtures__/bundles.ts`. The corrupted copies are hand-broken variants for
 * the failure paths.
 *
 * Shape parsing runs everywhere. Full cryptographic verification hits the
 * sigstore TUF CDN, so it is network-gated: set `ION_SIGSTORE_NETWORK_TESTS=1`
 * to run it. This file must NOT mock the `sigstore` module (the adapter's
 * other test file does, per-file).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractBundleFacts, realSigstoreVerifier } from './sigstore-adapter.js';

const fixture = (name: string) => new URL(`./__fixtures__/${name}`, import.meta.url);
const readJson = (name: string) => JSON.parse(readFileSync(fixture(name), 'utf8'));

const ARTIFACT = readFileSync(fixture('audit-0.1.2.block.json'));
const BUNDLE = readJson('audit-0.1.2.block.json.sigstore.json');
const CORRUPT_PAYLOAD = readJson('audit-0.1.2.corrupt-payload.sigstore.json');
const TRUNCATED_SIG = readJson('audit-0.1.2.truncated-sig.sigstore.json');

const ARTIFACT_SHA256 = createHash('sha256').update(ARTIFACT).digest('hex');
const ATTEST_COMMIT = 'e6f8ef95000306449ac024d8bd0b0dbc281275f9';

describe('real attested bundle (shape parsing, no network)', () => {
  it('subject digest matches the committed artifact bytes', () => {
    const facts = extractBundleFacts(BUNDLE);
    expect(facts.subjectDigests).toContain(ARTIFACT_SHA256);
  });

  it('carries the GitHub Actions issuer and the source repository + commit', () => {
    const facts = extractBundleFacts(BUNDLE);
    expect(facts.issuer).toBe('https://token.actions.githubusercontent.com');
    expect(facts.sourceRepository).toBe('https://github.com/jaredgrabill/ion-drive-blocks');
    expect(facts.sourceCommit).toBe(ATTEST_COMMIT);
  });

  it('throws on the hand-corrupted payload', () => {
    expect(() => extractBundleFacts(CORRUPT_PAYLOAD)).toThrow();
  });

  it('still shape-parses the truncated-signature copy (crypto is the verifier job)', () => {
    const facts = extractBundleFacts(TRUNCATED_SIG);
    expect(facts.subjectDigests).toContain(ARTIFACT_SHA256);
  });
});

// Full verification needs the sigstore TUF root over the network — opt in.
describe.runIf(process.env.ION_SIGSTORE_NETWORK_TESTS)(
  'realSigstoreVerifier against the real bundle (network)',
  () => {
    it('verifies the genuine bundle', async () => {
      const outcome = await realSigstoreVerifier().verifyBundle(BUNDLE);
      expect(outcome.kind).toBe('verified');
      if (outcome.kind === 'verified') {
        expect(outcome.facts.subjectDigests).toContain(ARTIFACT_SHA256);
        expect(outcome.facts.sourceCommit).toBe(ATTEST_COMMIT);
      }
    });

    it('rejects the truncated-signature copy as invalid', async () => {
      const outcome = await realSigstoreVerifier().verifyBundle(TRUNCATED_SIG);
      expect(outcome.kind).toBe('invalid');
    });
  },
);
