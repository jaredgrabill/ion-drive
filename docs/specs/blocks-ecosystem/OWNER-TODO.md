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
   spec-05's exit criteria. *(Folded into "From spec-05" item 4 below.)*

## From spec-05 (publishing pipeline)

Prereq for all of these: **F23's first npm publish** (`@ion-drive/cli` +
`@ion-drive/core` on npm — the workflows `npm i -g @ion-drive/cli@^0.3
@ion-drive/core@^0.3`).

1. **Push the migrated blocks repo + tag the reusable workflow.** The
   migration (versioned `dist/<version>/` artifacts, protocol-v1
   `registry/`, workflows, runbook, schemas, `.nojekyll`) sits uncommitted in
   `I:\ion-shift\blocks`:

   ```bash
   cd I:\ion-shift\blocks
   git add -A && git commit -m "Registry protocol v1: versioned artifacts, publish workflows, runbook (spec-05)"
   git remote add origin https://github.com/jaredgrabill/ion-drive-blocks.git   # if not already
   git push -u origin main
   git tag v1 && git push origin v1     # third parties: uses: jaredgrabill/ion-drive-blocks/.github/workflows/publish-block.yml@v1
   ```

2. **Enable Pages + DNS, then curl-sanity the live registry.** Repo Settings →
   Pages → Source: *GitHub Actions*; custom domain `registry.iondrive.dev`
   (DNS CNAME → `jaredgrabill.github.io`), enforce HTTPS. Then:

   ```bash
   curl -fsS https://registry.iondrive.dev/registry/index.json | jq .schemaVersion   # → 1
   curl -fsS https://registry.iondrive.dev/registry/blocks/crm.json | jq .latest
   curl -fsSI https://registry.iondrive.dev/crm/dist/0.2.0/block.json                # → 200
   curl -fsS https://registry.iondrive.dev/schemas/registry-index.v1.json | jq '.["$id"]'
   curl -fsS https://registry.iondrive.dev/registries.json | jq '.registries[].namespace'
   ```

3. **AC3 — dry-run rehearsal of the publish workflow.** Actions → *publish* →
   Run workflow (dry-run stays `true`), or:

   ```bash
   gh workflow run publish.yml --repo jaredgrabill/ion-drive-blocks -f dry-run=true
   ```

   Must complete green with a correct would-publish summary and **no commit**.

4. **AC4 — first real publish + verification.** The migrated tree already has
   artifacts for every current version, so publishing the *current* versions
   means the attest step runs against them on the first `main` push (packed[]
   is empty only if artifacts were committed in step 1 — in that case bump any
   block's patch version to exercise the full loop, or delete-and-let-CI-pack
   in the same PR). After the run:

   ```bash
   gh attestation verify crm/dist/0.2.0/block.json --repo jaredgrabill/ion-drive-blocks   # per block
   # from a scratch ion-drive project:
   ion-drive add crm            # must resolve via registry.iondrive.dev, digest-verify, show ◆ official
   ion-drive block verify crm@0.2.0   # digest OK, attestation OK, tier official
   ```

   This doubles as spec-04's live smoke — and closes spec-04's fixture item
   (§"From spec-04" #1 above): commit the produced `*.sigstore.json` + exact
   artifact bytes as CLI test fixtures.

5. **AC5 — third-party registry flow.** Create a scratch registry repo (any
   account), seed it with a `registry.config.json` (`{ "name": "Scratch
   Registry" }`) and the thin caller (`publish.yml` with
   `uses: jaredgrabill/ion-drive-blocks/.github/workflows/publish-block.yml@v1`),
   then from any block directory:

   ```bash
   ion-drive block publish --registry-repo <owner>/<scratch-repo>   # opens the PR
   ```

   Merge the PR; the workflow run must attest and commit; then
   `ion-drive registry add @scratch <pages-url>/registry/index.json` +
   `ion-drive add @scratch/<block>` must install `✔ verified`. (The local half
   — publish → serve → install by ref, minus attestation — was already
   rehearsed against a local bare repo in the spec-05 smoke.)
