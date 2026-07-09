# Blocks ecosystem — owner-run follow-ups

Items only the repo owner can complete (secrets, real CI runs, live publishes).
Prune entries as they are done.

**Sequencing (finalized 2026-07-08, M1+M1.5 shipped):** everything below is gated
on roadmap **F23** — the first npm publish of `@ion-drive/{core,cli,client,admin}`
(`NPM_TOKEN` secret + `v0.x` tag → `release.yml`). Then, in order:
spec-05 §1 (push + tag the blocks repo) → §2 (Pages + DNS) → §3 (dry-run
dispatch) → §4 (first attested publish — also closes spec-04's fixture item and
runs its live verify) → §5 (third-party flow) → spec-06 §1–2 (blocks CI green +
the published-CLI dogfood loop). Both repos' Phase 18 commits are already made
locally; nothing has been pushed.

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

## From spec-06 (block test + CI)

Prereq: **F23's first npm publish** (the workflows install
`@ion-drive/cli@^0.3 @ion-drive/core@^0.3` from npm) and the blocks repo
pushed to GitHub (spec-05 item 1).

1. **AC1 Linux leg — blocks-repo CI goes green.** After pushing
   `jaredgrabill/ion-drive-blocks`, its `ci.yml` now runs `ion-drive block
   test <dir> --deps-from .` for every block against a Postgres 17 service
   container. The first post-F23 CI run on `main` must be green for all five
   blocks (the Windows leg was rehearsed locally on 2026-07-08 — 5/5 green).

2. **AC6 — the dogfood loop with the published CLI.** In a scratch repo:

   ```bash
   npm i -g @ion-drive/cli @ion-drive/core
   ion-drive block new demo && cd block-demo
   git init && git add -A && git commit -m init
   # then run the scaffolded .github/workflows/ci.yml on GitHub (or its steps
   # by hand): block validate . / block pack . /
   # block test . --json --database-url … / the dist/ drift guard
   ```

   Must pass green end-to-end with the *published* packages (the same loop was
   rehearsed locally with the built CLI on 2026-07-08 — validate/pack/test
   green, repack byte-identical).

## From spec-05 (publishing pipeline)

Prereq for all of these: **F23's first npm publish** (`@ion-drive/cli` +
`@ion-drive/core` on npm — the workflows `npm i -g @ion-drive/cli@^0.3
@ion-drive/core@^0.3`).

1. **Push the migrated blocks repo + tag the reusable workflow.** The
   migration (versioned `dist/<version>/` artifacts, protocol-v1
   `registry/`, workflows, runbook, schemas, `.nojekyll`) is committed locally
   in `I:\ion-shift\blocks` (commits `f5c1ef9` spec-05 + `d2f897e` spec-06):

   ```bash
   cd I:\ion-shift\blocks
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
