# Spec 05 — Publishing Pipeline: `registry build`, `block publish`, and the Reusable Workflow

> **Status:** ✅ implemented 2026-07-08 (CLI `registry build`/`yank`/`deprecate` +
> `block publish`, blocks-repo migration to versioned paths + workflows + runbook +
> Pages config). **AC1/AC2/AC6** verified by unit tests + the local rehearsal smoke;
> **AC3, AC4, and AC5's live half are owner-deferred** (they need the repo on GitHub,
> F23's first npm publish, and Pages/DNS) — exact commands in
> [`OWNER-TODO.md`](OWNER-TODO.md) §"From spec-05". Local rehearsals of AC3 (script
> replay of the workflow's shell steps, idempotent second run) and AC5 (`block publish
> --direct` against a local bare registry repo, then install by ref from the served
> clone) were run and recorded in the implementation report.
>
> **Implementation notes vs. the text below:** (1) the `DEFAULT_REGISTRY_URL` swap in
> §5 had already landed with spec-03 — `BUILT_IN_REGISTRIES['@ion']` points at
> `https://registry.iondrive.dev/registry/index.json`; nothing to change here.
> (2) Pages layout = repo root is the site root (`/registry/index.json`,
> `/registry/blocks/<name>.json`, `/<name>/dist/<version>/block.json[.sigstore.json]`,
> `/schemas/*.v1.json`, `/registries.json`); spec-01's §6 example URL was amended to
> match. (3) `attestationUrl` absent→present is codified as the sole legal mutation of
> a released version entry (D5; amended into spec-01 §5). (4) New requirement
> discovered during implementation: a registry repo carries a hand-maintained
> **`registry.config.json`** at its root (`{ name, description?, homepage?,
> repository?, trust? }`) — `registry build` refuses without it; `repository` is
> stamped on every block doc (per-block override: manifest `meta.repository`); the
> official repo's is seeded with the ion-drive-blocks identity. (5) `block pack` now
> emits `dist/<version>/block.json` (the delete-the-defect path change, D8).

**Lands in:** `jaredgrabill/ion-drive` (`packages/cli`) and `jaredgrabill/ion-drive-blocks`
(workflows + layout migration + serving).
**Depends on:** specs 01, 02, 04. **Blocks on (external):** roadmap F23 — the first npm
publish of `@ion-drive/cli`/`core` and pushing `ion-drive-blocks` to GitHub must happen
before the workflow's `npm i -g` steps can run.

## Scope

How a block version gets from a working tree into a registry, immutably and attested:
the `ion-drive registry build` generator, the `ion-drive block publish` orchestrator,
the reusable GitHub Actions publish workflow (the block analog of `release.yml`), the
official blocks repo's migration to versioned artifact paths + the new workflow, and
serving the main registry at `registry.iondrive.dev`.

## Non-goals

- The hosted publish API (M3, spec-09) — this spec is the git/static path that M1–M2
  run on and that self-hosted registries use forever.
- `block test` in CI (spec-06 adds it to these workflows once it exists).

## Design

### 1. `ion-drive registry build [dir]` (new; joins the `registry` command group)

The single source of registry-JSON generation — shadcn's `build` analog. Given a
registry repo (default cwd) laid out as `<name>/block.json` (+ `code/`) directories plus
a `registry/` output dir:

1. **Discover** blocks by glob `*/block.json` (never a hardcoded list — the bug class
   that made the current CI skip `catalog`).
2. **Validate** each (`parseManifest` via project-first core import, as `block validate`).
3. For each block whose manifest `version` has no `dist/<version>/block.json` yet:
   **pack** it there (embedding `code/`), byte-identical to `ion-drive block pack`'s
   output. Compute its `digest` + `size`.
4. **Regenerate** `registry/blocks/<name>.json`: append the new version entry
   (`artifactUrl` relative, `publishedAt` = now, `dependencies`/`requires` mirrored from
   the manifest, `status: "active"`, `attestationUrl` set if the bundle file already
   exists beside the artifact — see §3 ordering); set `latest` to the highest non-prerelease
   active version. **Existing version entries are preserved byte-for-byte** — the
   generator refuses (exit ≠ 0, named file) to alter any existing `versions[v]` object
   or any existing `dist/<v>/` artifact. Mutable-field edits (`status`, `advisories`,
   display metadata) are done by hand or by `registry yank` (below), not by build.
5. **Regenerate** `registry/index.json` from the per-block files (`generatedAt` = now).

Flags: `--check` (CI mode: run everything, write nothing, fail on any would-be change —
the drift guard), `--block <name>` (limit), `--json`.

Also new, small: `ion-drive registry yank <name>@<version> --reason <text>` and
`registry deprecate <name>@<version> --reason` — edit the mutable status fields in the
local registry checkout (the git-registry admin loop; M3 gets an API for the hosted one).

### 2. `ion-drive block publish [dir]`

The local orchestrator for git-hosted registries:

```
ion-drive block publish [dir]
  --registry-repo <owner/repo>   # target registry repo (default: read from block's
                                 # publishConfig in block.json meta, else error)
  --pr | --direct                # open a PR (default) or push to the default branch
  --dry-run
```

Flow: `block validate` → clone/fetch the registry repo to a temp dir (`gh repo clone` /
`git`) → copy the block source dir in (or bump it) → `registry build` there → commit
`publish: <name>@<version>` → `--pr`: `gh pr create` with a rendered body (version,
digest, dep table) / `--direct`: push. Honest output: **"Publishing locally cannot
attest provenance. Merge via the publish workflow (or let CI attest on main) to get the
✔ verified badge"** — local publishes are `community` until CI attests; that incentive
structure is the same as npm's.

For the **official** repo the human flow is simpler: edit the block, bump `version` in
`block.json`, open a PR; CI validates; merge to `main` publishes (§3). `block publish`
exists for third parties running their own registry repos and for maintainers who prefer
the one-shot command.

### 3. The reusable publish workflow (`ion-drive-blocks/.github/workflows/publish-block.yml`)

A **reusable workflow** (`on: workflow_call`), not a composite action — it needs its own
`permissions` block, which composite actions can't declare:

```yaml
on:
  workflow_call:
    inputs:
      dry-run: { type: boolean, default: false }
      block:   { type: string, required: false }   # default: all with unpublished versions
permissions:
  contents: write        # commit dist/ + registry/ back
  id-token: write        # sigstore (Fulcio) OIDC
  attestations: write    # actions/attest-build-provenance
```

Steps (mirroring `release.yml`'s guard/dry-run/skip-if-published discipline):

1. Checkout; setup-node 22; `npm i -g @ion-drive/cli @ion-drive/core` (pinned
   `@^<major.minor>`; version-skew warning already exists in the CLI).
2. **Guards:** `ion-drive registry build --check` must show only *additions*; a diff
   touching any existing `dist/<version>/**` or existing `versions[v]` entry fails the
   job (immutability guard — implemented by `--check`'s refusal + an independent
   `git diff --name-only` belt against `dist/*/`).
3. `ion-drive registry build` (packs new versions, updates registry JSON).
4. Per newly-packed artifact: `actions/attest-build-provenance` with
   `subject-path: <name>/dist/<version>/block.json`, then `gh attestation download` (or
   the action's bundle output) written adjacent as `block.json.sigstore.json`; re-run
   `registry build` (idempotent) so `attestationUrl` lands in the per-block JSON.
5. `git commit -m "publish: <names@versions>"` + push to `main` (skipped on `dry-run`;
   `[skip ci]` not used — the publish commit must itself pass CI, and change detection
   makes the re-run a no-op).
6. Job summary: table of published versions, digests, attestation links (Rekor log
   index).

**Official repo trigger** (`publish.yml`, thin caller):

```yaml
on:
  push: { branches: [main] }
  workflow_dispatch: { inputs: { dry-run: { default: true } } }
jobs:
  publish:
    uses: ./.github/workflows/publish-block.yml
    with: { dry-run: ${{ inputs.dry-run || false }} }
```

Change detection is inherent: a version already packed/attested is skipped; a merged PR
that bumped `crm` to 0.3.0 publishes exactly `crm@0.3.0`. No tags needed — **blocks
regain per-block release cadence inside the single repo** (restoring what the ADR-018
re-amendment traded away, without splitting repos).

**Third-party use:** a third party's registry repo copies the thin caller and
`uses: jaredgrabill/ion-drive-blocks/.github/workflows/publish-block.yml@v1` (we tag the
workflow); or they run the same steps against their own Pages/S3 deploy. The `block new`
scaffold ships this caller (spec-06).

### 4. Official repo migration + CI fix (one PR in `ion-drive-blocks`)

- Move artifacts to versioned paths: `crm/dist/0.2.0/block.json` etc. (delete the
  mutable `crm/dist/block.json` — **this is the one legacy defect that becomes un-fixable
  after adoption**; do it before any public announcement).
- Generate `registry/blocks/*.json` + v1 `registry/index.json` via `registry build`;
  delete the legacy index shape.
- Rewrite `ci.yml`: glob-discovered validate loop (**fixes the missing-`catalog` gap**),
  `registry build --check` as the drift guard, plus (once spec-06 lands) `block test`.
- Add `publish.yml` + `publish-block.yml` per §3; tag `v1` for reusable-workflow
  consumers.
- Repo docs: README "publishing a version" section; `docs/platform.md` registry section
  updated to protocol v1.

### 5. Serving: `registry.iondrive.dev`

GitHub Pages (or Cloudflare Pages — implementer's choice, requirements below) on the
`ion-drive-blocks` repo, custom domain `registry.iondrive.dev`, serving the repo root
(registry JSON + artifacts + attestation bundles + `/schemas/*` from spec-01, checked in
or built into the Pages artifact). Requirements:

- HTTPS with the custom domain from day one — **nothing anywhere hard-codes
  raw.githubusercontent.com after this spec** (the CLI's `DEFAULT_REGISTRY_URL` becomes
  `https://registry.iondrive.dev/registry/index.json`... choose final path shape with the
  Pages layout; document it in spec-01's examples if it differs).
- Immutable cache headers on `dist/**` where the host allows (Cloudflare Pages
  `_headers` file; GitHub Pages can't — acceptable, digests make caching safe
  regardless).
- The `registries.json` directory file lives here too.

DNS/domain setup is owner-run; the spec's deliverable is the Pages config + a
`docs/registry-operations.md` runbook in the blocks repo (publish, yank, advisory,
directory-PR review checklist, takedown interim procedure per spec-01 §5).

## Implementation notes (files)

- `packages/cli/src/commands/registry.ts` — `build`/`--check`/`yank`/`deprecate`
  subcommands; packing reuses `readLocalBlock`/pack internals from `commands/block.ts`
  (extract shared helpers into `src/registry/build.ts`, pure + injectable fs for tests).
- `packages/cli/src/commands/block.ts` — `publish` command; `gh` invoked via
  `child_process` with graceful "install GitHub CLI" error.
- `packages/cli/src/registry/registry-client.ts` — `DEFAULT_REGISTRY_URL` swap.
- `ion-drive-blocks`: workflows, migration, runbook (see §4).
- Docs (ion-drive repo): `docs/concepts/building-blocks.md` publishing section;
  `getting-started`/README pointers.

## Acceptance criteria

1. `registry build` on the migrated official repo is a no-op (`--check` exits 0); bump a
   fixture block's version ⇒ build emits exactly the new `dist/<v>/`, updated per-block
   JSON (old entries byte-identical), updated index; attempting to change a released
   file ⇒ named refusal.
2. `--check` catches: mutated existing artifact, mutated existing version entry, missing
   dist for a manifest version, index/per-block drift.
3. Dry-run `workflow_dispatch` of the official publish workflow completes green with a
   correct would-publish summary and no commit (the `release.yml` rehearsal pattern).
4. First real publish: all five blocks re-published at their current versions to
   versioned paths with attestation bundles; `gh attestation verify
   <artifact> --repo jaredgrabill/ion-drive-blocks` passes for each; `ion-drive add crm`
   from a scratch project resolves via `registry.iondrive.dev`, digest-verifies, and
   shows `◆ official` (this doubles as spec-04's live smoke).
5. `block publish --pr` against a scratch third-party registry repo produces a mergeable
   PR whose merge + workflow run yields a `✔ verified` block installable by ref.
6. `registry yank` produces the status/advisory edits and the resolver honors them
   (fixture-level).

## Test plan

- Unit: `build.ts` generator (in-memory fs) — discovery, pack-if-missing, append-only
  enforcement, latest computation, `--check` matrix; publish command argument/flow tests
  with stubbed `gh`.
- Workflow verification is live-by-nature: the dry-run rehearsal + first real publish
  above are the test, recorded as a numbered smoke in the PR (repo convention).
