/**
 * Hand-built, bundle-shaped JSON fixtures for the sigstore adapter's pure
 * shape-parsing (`extractBundleFacts`) and the tier policy tests.
 *
 * These are NOT cryptographically valid sigstore bundles — they exercise the
 * *shape* seam only (DSSE payload decode, subject extraction, Fulcio
 * extension scan). Real bundles produced by `actions/attest-build-provenance`
 * ride in with spec-05's first attested publish (see
 * `docs/specs/blocks-ecosystem/OWNER-TODO.md`) and are verified end-to-end by
 * the owner-run smoke — the cryptographic path itself is the sigstore
 * library's job, exercised behind the `realSigstoreVerifier` seam.
 */

import { encodeOidTlv } from '../sigstore-adapter.js';

/** Fulcio OIDs used by the fixture certificate (keep in sync with the adapter). */
const OID_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';
const OID_SOURCE_REPO_URI = '1.3.6.1.4.1.57264.1.12';
const OID_SOURCE_REPO_DIGEST = '1.3.6.1.4.1.57264.1.13';

/** One DER extension blob: `OID || OCTET STRING( UTF8String(value) )`. */
function utf8Extension(oid: string, value: string): Buffer {
  const utf8 = Buffer.from(value, 'utf8');
  const inner = Buffer.concat([Buffer.from([0x0c, utf8.length]), utf8]);
  return Buffer.concat([encodeOidTlv(oid), Buffer.from([0x04, inner.length]), inner]);
}

export interface FixtureBundleInput {
  /** Hex sha256 the in-toto statement claims as its subject. */
  subjectSha256: string;
  issuer?: string;
  sourceRepository?: string;
  sourceCommit?: string;
}

/**
 * Builds a bundle-shaped JSON object: a base64 DSSE in-toto payload plus a
 * synthetic "certificate" DER containing just the Fulcio extension TLVs the
 * adapter's extension scan reads.
 */
export function buildFixtureBundle(input: FixtureBundleInput): Record<string, unknown> {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'block.json', digest: { sha256: input.subjectSha256 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {},
  };
  const extensions: Buffer[] = [];
  if (input.issuer) extensions.push(utf8Extension(OID_ISSUER_V2, input.issuer));
  if (input.sourceRepository) {
    extensions.push(utf8Extension(OID_SOURCE_REPO_URI, input.sourceRepository));
  }
  if (input.sourceCommit) {
    extensions.push(utf8Extension(OID_SOURCE_REPO_DIGEST, input.sourceCommit));
  }
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: { rawBytes: Buffer.concat(extensions).toString('base64') },
      tlogEntries: [],
    },
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify(statement), 'utf8').toString('base64'),
      signatures: [{ sig: Buffer.from('fixture-signature').toString('base64') }],
    },
  };
}

/** A corrupted copy: the DSSE payload is not valid base64 JSON. */
export function corruptPayloadBundle(input: FixtureBundleInput): Record<string, unknown> {
  return { ...buildFixtureBundle(input), dsseEnvelope: { payload: '!!not-base64-json!!' } };
}

/** A corrupted copy: no DSSE envelope at all (e.g. a message-signature bundle). */
export function missingEnvelopeBundle(input: FixtureBundleInput): Record<string, unknown> {
  const { dsseEnvelope: _dropped, ...rest } = buildFixtureBundle(input);
  return rest;
}
