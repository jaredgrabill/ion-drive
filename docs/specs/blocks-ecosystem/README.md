# Blocks Registry Ecosystem — Spec Suite

**Status:** Accepted for implementation (2026-07-08). Decision record: ADR-022 in
`docs/research/architecture-decisions.md`. Research basis:
`docs/research/blocks-registry-ecosystem.md`.

This suite specifies the shadcn-style distribution ecosystem for Ion Drive blocks: a main
hosted registry run by us, third-party self-hosted registries (public or private), CLI
publishing and registry management, real semver versioning, artifact integrity
(hash/timestamp/provenance), a verified/official trust mark, and the full SDLC for
developing, testing, and publishing blocks.

Each spec is sized to be forked to **one implementation agent** and follows the same
skeleton: Scope / Non-goals / Design / Implementation notes / Acceptance criteria / Test
plan. Specs live here in the platform repo even when the work lands elsewhere (the blocks
repo, a site repo) — one place to fork agents from.

## The one-paragraph architecture

A **registry** is a set of static JSON files served over HTTPS from any host (GitHub
Pages, S3, nginx — no server required): a small `index.json` directory, one
`blocks/<name>.json` per block carrying the full version history with a **sha256 digest
per immutable version**, and versioned artifacts (`<name>/dist/<version>/block.json`,
the manifest with vendored code embedded) with an optional **sigstore attestation bundle**
adjacent. Projects configure registries as namespaces in `ion.config.json`
(`"@acme": "https://…"`), with `@ion` (our main registry) built in. `ion-drive add
@acme/billing@^1.2` resolves semver ranges across the dependency closure, **verifies the
digest before vendoring or installing anything**, and records
name/version/digest/source in `ion.config.json` (which doubles as the lockfile — blocks
are singletons per server). Publishing is CI-first: a reusable GitHub Actions workflow
validates → packs → **attests via GitHub artifact attestations (Fulcio/Rekor — no custom
PKI)** → appends the immutable version entry to the registry. The CLI computes trust
tiers itself: `official` (our blocks), `verified` (attestation checks out against the
claimed repo), `community` (unattested). The read path stays static/CDN forever; the
eventual hosted write-side service (M3) is built **on Ion Drive itself** and only ever
generates static files.

## Spec index

| # | Spec | Lands in | Depends on |
|---|------|----------|------------|
| 01 | [Registry protocol v1](spec-01-registry-protocol.md) — file layout, JSON shapes + schemas, relative-URL resolution, immutability/status/advisories, trust field semantics | ion-drive (schemas) + ion-drive-blocks (layout) | — |
| 02 | [Manifest v1 + semver](spec-02-manifest-semver.md) — strict semver `version`, `dependencies` as name→range map, `requires.core`, installer preflight | ion-drive core + ion-drive-blocks | — |
| 03 | [CLI registries + resolution](spec-03-cli-registries-and-resolution.md) — `registries` config map, `@ns/name` refs, resolver (range collection + maxSatisfying), per-registry cache, `registry add/list/remove` | ion-drive cli | 01, 02 |
| 04 | [Integrity, provenance, trust](spec-04-integrity-provenance-trust.md) — digest verification at add, `block verify`, sigstore policy, trust tiers + badges, install `source` envelope, ledger columns | ion-drive cli + core | 01, 02, 03 |
| 05 | [Publishing pipeline](spec-05-publishing-pipeline.md) — `registry build`, `block publish`, reusable publish workflow (attest + immutability guard), official-repo flow, `registry.iondrive.dev` serving | ion-drive cli + ion-drive-blocks | 01, 02, 04 |
| 06 | [Block test + CI](spec-06-block-test-and-ci.md) — `block test` (ephemeral server), regenerated `block new` scaffold, `ion-drive audit` | ion-drive cli | 02, 05 |
| 07 | [Diff + update](spec-07-diff-and-update.md) — `ion-drive diff`/`update`, installer upgrade mode, `.new`-file convention | ion-drive cli + core | 02, 04 |
| 08 | [Registry site (M2)](spec-08-registry-site-m2.md) — static directory/block pages, search index + `ion-drive search`, registries directory, registry MCP tools | site (ion-drive-blocks `/site` or own repo) | 01, 05 |
| 09 | [Hosted registry (M3) — DRAFT](spec-09-hosted-registry-m3.md) — accounts, name policy, publish API, OIDC trusted publishing, yank/takedown, verified-mark issuance | new service repo | 05, 08 |

## Milestones

**M1 — Ecosystem core (specs 01→02, then 03 ∥ 04, then 05).**
Specs 01+02 define the wire format everything consumes (02 touches core's Zod, so it
rides a core release). 03 and 04 can run as parallel agents once 01+02 land. 05 last.
**Exit criteria:** protocol-v1 registry live at `registry.iondrive.dev`; all official
blocks published as immutable, attested versions via GitHub Actions; `ion-drive add`
verifies digests; trust badges render in `list`/`add`.

**M1.5 — SDLC (specs 06 ∥ 07).**
**Exit criteria:** `block test` green in the official repo's CI for every block;
`ion-drive diff`/`update` closes the slipped Phase-14 stretch item.

**M2 — Read-side registry product (spec 08).**
**Exit criteria:** browsable site + search + registry MCP tools + PR-reviewed registries
directory.

**M3 — Hosted write side (spec 09, re-specced after M2 with real data).**
**Exit criteria:** third parties publish to the main registry via tokens/OIDC without
sending us PRs; verified marks issued; takedown runbook operational.

**Sequencing dependency (external):** specs 05/06 install `@ion-drive/cli` + `core` from
npm inside workflows — roadmap **F23's owner-run first publish must complete first**
(`NPM_TOKEN`/trusted-publisher registration + `v0.x` tag, GHCR push, and pushing
`jaredgrabill/ion-drive-blocks` to GitHub).

## Glossary

- **Block** — an installable domain package: a JSON **manifest** (objects, relationships,
  seed, tasks, roles, subscriptions, webhooks, actions, hooks, requires) plus optional
  vendored TypeScript (`code[]`) copied into the user's `/blocks/<name>` tree.
- **Artifact** — the published, immutable file `…/dist/<version>/block.json`: the manifest
  with `code[]` embedded, exactly as emitted by `ion-drive block pack`. The unit that is
  hashed, attested, fetched, and installed.
- **Registry** — a set of static JSON files conforming to protocol v1 (spec-01). Anyone
  can host one; ours is the **main registry** (`@ion`, `registry.iondrive.dev`).
- **Namespace** — the `@handle` a project's `ion.config.json` maps to a registry URL.
  A namespace is a *source*, not an identity: the server ledger keys blocks by bare name.
- **Digest** — `sha256:<hex>` over the exact published artifact bytes.
- **Attestation** — a sigstore bundle produced by GitHub artifact attestations binding the
  artifact digest to the repo + workflow + commit that built it.
- **Trust tiers** — `official` (published from `jaredgrabill/ion-drive-blocks`),
  `verified` (attestation validates against the claimed repo), `community` (everything
  else). Computed by the CLI, never self-asserted.

## Cross-cutting rules (bind every spec)

1. **Third-party parity** (ADR-018): official blocks ride the exact pipeline third
   parties use. No private shortcuts.
2. **The ownership contract** (ADR-018): `ion-drive add` copies a block's code
   shadcn-style into `/blocks/<name>` in the user's initialized project — from that
   moment the code is the user's. Everything in this suite serves that model without
   ever violating it: integrity checks run **before** vendoring (the artifact embeds
   the code, so one digest covers both the manifest and what lands in the tree);
   `diff`/`update` compare against the pristine ledger snapshot and write `.new` files
   beside user-modified ones, never over them; `remove` leaves the folder; no tool
   auto-overwrites or deletes user code, ever.
3. **Static read path**: fetching indexes/blocks/artifacts must never require a running
   service. M3's service only *generates* static files.
4. **Immutability**: a published `(name, version)`'s artifact bytes and digest never
   change. Mutable: `latest`, `status`, `advisories`. Documented exception: malware
   takedown (yank + artifact removal + advisory).
5. **Clean break, now**: nothing is published yet (F23 open), so the interim unversioned index (today's
   `registry/index.json`) is replaced, not supported. No compatibility code.
6. **Verification is not optional**: a digest mismatch is a hard failure with no
   `--force` override.
7. **LLM-first DX**: every new CLI command gets `--json` output; registry data is exposed
   to agents via MCP (spec-08); specs keep the heavily-commented-code convention.
8. **Surface parity**: server-side changes (install envelope, ledger fields) reflect into
   OpenAPI/MCP/admin per the repo's surface-parity skill.
