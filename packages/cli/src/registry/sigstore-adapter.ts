/**
 * Sigstore attestation adapter (spec-04 §3) — the ONLY file that touches the
 * real `sigstore` library.
 *
 * Everything else programs against {@link SigstoreVerifier}, a one-method
 * seam returning a classified {@link AttestationOutcome}:
 *
 *  - `verified` — the bundle checks out cryptographically against the public
 *    sigstore trust root (Fulcio chain + Rekor/timestamp, done by the
 *    library), plus the extracted facts the tier policy needs.
 *  - `invalid`  — the bundle is present but wrong (malformed shape, bad
 *    signature, failed chain). Treat as unattested; can indicate tampering.
 *  - `unavailable` — the check could not run (library missing, TUF root
 *    unreachable offline). Degrades to community tier with a warning —
 *    NEVER a crash (spec-04 AC7).
 *
 * Fact extraction is pure and separate ({@link extractBundleFacts}) so the
 * shape-parsing is unit-testable with hand-built bundle fixtures: the DSSE
 * payload's in-toto subject sha256s, and the Fulcio certificate's OIDC
 * issuer / source-repository / source-commit claims, read from the cert DER
 * by scanning for the Fulcio extension OIDs (a full X.509 parser would be
 * overkill for four extensions).
 */

/** Facts the tier policy consumes, extracted from a bundle. */
export interface BundleFacts {
  /** Hex sha256s of the in-toto statement's subjects. */
  subjectDigests: string[];
  /** OIDC issuer claim from the Fulcio certificate. */
  issuer?: string;
  /** Source repository claim (URI or `owner/repo`) from the certificate. */
  sourceRepository?: string;
  /** Source commit sha from the certificate. */
  sourceCommit?: string;
}

export type AttestationOutcome =
  | { kind: 'verified'; facts: BundleFacts }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unavailable'; reason: string };

/** The seam commands inject (tests pass fakes; production uses the real one). */
export interface SigstoreVerifier {
  verifyBundle(bundleJson: unknown): Promise<AttestationOutcome>;
}

// ---------------------------------------------------------------------------
// Bundle shape parsing (pure — fixture-tested)
// ---------------------------------------------------------------------------

/** Fulcio certificate extension OIDs (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md). */
const OID_ISSUER_V1 = '1.3.6.1.4.1.57264.1.1'; // raw string value
const OID_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8'; // DER UTF8String value
const OID_SOURCE_REPO_URI = '1.3.6.1.4.1.57264.1.12'; // DER UTF8String
const OID_SOURCE_REPO_DIGEST = '1.3.6.1.4.1.57264.1.13'; // DER UTF8String
const OID_GITHUB_WORKFLOW_REPO = '1.3.6.1.4.1.57264.1.5'; // raw "owner/repo"
const OID_GITHUB_WORKFLOW_SHA = '1.3.6.1.4.1.57264.1.3'; // raw commit sha

/**
 * Parses a sigstore bundle's JSON shape into {@link BundleFacts}.
 * @throws {Error} for anything that is not a DSSE in-toto bundle — callers
 * classify that as `invalid`.
 */
export function extractBundleFacts(bundleJson: unknown): BundleFacts {
  const bundle = bundleJson as {
    dsseEnvelope?: { payload?: string; payloadType?: string };
    verificationMaterial?: {
      certificate?: { rawBytes?: string };
      x509CertificateChain?: { certificates?: { rawBytes?: string }[] };
    };
  } | null;
  if (!bundle || typeof bundle !== 'object') throw new Error('bundle is not a JSON object');

  const payload = bundle.dsseEnvelope?.payload;
  if (typeof payload !== 'string') throw new Error('bundle has no dsseEnvelope.payload');
  let statement: { subject?: { digest?: { sha256?: string } }[] };
  try {
    statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    throw new Error('bundle DSSE payload is not base64 JSON');
  }
  const subjectDigests = (statement.subject ?? [])
    .map((s) => s.digest?.sha256)
    .filter((d): d is string => typeof d === 'string')
    .map((d) => d.toLowerCase());
  if (subjectDigests.length === 0) throw new Error('bundle statement declares no sha256 subjects');

  // Leaf certificate: modern bundles carry `certificate`; older ones a chain.
  const certBase64 =
    bundle.verificationMaterial?.certificate?.rawBytes ??
    bundle.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (typeof certBase64 !== 'string') throw new Error('bundle has no signing certificate');
  const der = Buffer.from(certBase64, 'base64');

  return {
    subjectDigests,
    issuer: extensionUtf8(der, OID_ISSUER_V2) ?? extensionRaw(der, OID_ISSUER_V1) ?? undefined,
    sourceRepository:
      extensionUtf8(der, OID_SOURCE_REPO_URI) ??
      extensionRaw(der, OID_GITHUB_WORKFLOW_REPO) ??
      undefined,
    sourceCommit:
      extensionUtf8(der, OID_SOURCE_REPO_DIGEST) ??
      extensionRaw(der, OID_GITHUB_WORKFLOW_SHA) ??
      undefined,
  };
}

// --- Minimal DER helpers (extension scan, not a full X.509 parser) -----------

/** Encodes a dotted OID as its full DER TLV (`0x06 len body`). */
export function encodeOidTlv(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const body: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
  for (const value of parts.slice(2)) {
    // Base-128 with the high bit set on all but the last septet.
    const septets: number[] = [];
    let v = value;
    do {
      septets.unshift(v & 0x7f);
      v >>= 7;
    } while (v > 0);
    for (let i = 0; i < septets.length - 1; i++) septets[i] = (septets[i] ?? 0) | 0x80;
    body.push(...septets);
  }
  return Buffer.from([0x06, body.length, ...body]);
}

/** Reads one DER TLV at `offset`: tag, content start, content length. */
function readTlv(der: Buffer, offset: number): { tag: number; start: number; length: number } {
  const tag = der[offset] ?? 0;
  let lenByte = der[offset + 1] ?? 0;
  let start = offset + 2;
  let length = lenByte;
  if (lenByte & 0x80) {
    const lenBytes = lenByte & 0x7f;
    length = 0;
    for (let i = 0; i < lenBytes; i++) {
      length = (length << 8) | (der[offset + 2 + i] ?? 0);
    }
    start = offset + 2 + lenBytes;
    lenByte = length;
  }
  return { tag, start, length };
}

/**
 * Finds an X.509 extension's OCTET-STRING contents by scanning the DER for
 * the extension OID TLV. Sufficient for Fulcio's private-arc OIDs (their
 * byte patterns cannot occur incidentally inside other fields in practice).
 */
function extensionValue(der: Buffer, oid: string): Buffer | null {
  const needle = encodeOidTlv(oid);
  const at = der.indexOf(needle);
  if (at === -1) return null;
  let cursor = at + needle.length;
  // Optional `critical BOOLEAN` between the OID and the value.
  if (der[cursor] === 0x01) {
    const skip = readTlv(der, cursor);
    cursor = skip.start + skip.length;
  }
  const value = readTlv(der, cursor);
  if (value.tag !== 0x04) return null; // extnValue is always an OCTET STRING
  return der.subarray(value.start, value.start + value.length);
}

/** Extension whose OCTET STRING wraps a DER UTF8String (Fulcio v2 style). */
function extensionUtf8(der: Buffer, oid: string): string | null {
  const value = extensionValue(der, oid);
  if (!value || value[0] !== 0x0c) return null;
  const inner = readTlv(value, 0);
  return value.subarray(inner.start, inner.start + inner.length).toString('utf8');
}

/** Extension whose OCTET STRING holds the raw string (Fulcio v1 style). */
function extensionRaw(der: Buffer, oid: string): string | null {
  const value = extensionValue(der, oid);
  return value && value.length > 0 ? value.toString('utf8') : null;
}

// ---------------------------------------------------------------------------
// The real verifier
// ---------------------------------------------------------------------------

/** Errors that mean "we could not check", not "the bundle is bad". */
const UNAVAILABLE_PATTERN =
  /TUF|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|getaddrinfo|Cannot find (module|package)/i;

/**
 * The production {@link SigstoreVerifier}: dynamic-imports `sigstore` (zero
 * load cost unless a bundle URL is actually present) and verifies the bundle
 * against the library's shipped, TUF-updated trust root. Every failure is
 * caught and classified — this function never throws (AC7).
 */
export function realSigstoreVerifier(): SigstoreVerifier {
  return {
    async verifyBundle(bundleJson: unknown): Promise<AttestationOutcome> {
      let facts: BundleFacts;
      try {
        facts = extractBundleFacts(bundleJson);
      } catch (err) {
        return { kind: 'invalid', reason: `bundle is malformed: ${(err as Error).message}` };
      }

      let sigstore: { verify: (bundle: never) => Promise<unknown> };
      try {
        sigstore = (await import('sigstore')) as unknown as typeof sigstore;
      } catch (err) {
        return {
          kind: 'unavailable',
          reason: `sigstore library could not be loaded: ${(err as Error).message}`,
        };
      }

      try {
        // DSSE bundles embed their payload; no artifact argument needed. The
        // library validates the Fulcio chain + transparency log evidence
        // against its bundled TUF root (refreshed over the network when stale).
        await sigstore.verify(bundleJson as never);
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        if (UNAVAILABLE_PATTERN.test(reason)) {
          return { kind: 'unavailable', reason: `sigstore trust root unavailable: ${reason}` };
        }
        return { kind: 'invalid', reason: `bundle failed verification: ${reason}` };
      }
      return { kind: 'verified', facts };
    },
  };
}
