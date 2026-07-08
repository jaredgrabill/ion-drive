# Blocks ecosystem — owner-run follow-ups

Items only the repo owner can complete (secrets, real CI runs, live publishes).
Prune entries as they are done.

## From spec-04 (integrity, provenance, trust)

1. **Generate real attestation fixtures.** The spec-04 test suite exercises the
   sigstore adapter with hand-built bundle-*shaped* fixtures
   (`packages/cli/src/registry/__fixtures__/bundles.ts`) — they cover shape
   parsing and the tier policy, not real cryptography. Once CI can run
   `actions/attest-build-provenance` (needs the repo on GitHub with
   `id-token: write` + `attestations: write`):
   - attest a scratch artifact in this repo's CI **once**, and commit the
     produced bundle (`*.sigstore.json`) + the exact artifact bytes as fixtures
     under `packages/cli/src/registry/__fixtures__/`;
   - also commit hand-corrupted copies (flipped payload byte, truncated
     signature) for the failure cases;
   - extend `sigstore-adapter.test.ts` to run `realSigstoreVerifier()` against
     the real bundle (network-gated or with a vendored TUF root snapshot).

2. **Real `block verify` smoke against the first attested publish.** Rides
   spec-05 / roadmap F23: after the first publish from
   `jaredgrabill/ion-drive-blocks` with the attest step enabled, run
   `ion-drive block verify crm@<version>` against the live registry and record
   the verdict (digest OK, attestation OK, tier `official`) as part of
   spec-05's exit criteria.
