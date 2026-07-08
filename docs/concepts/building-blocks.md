# Building Blocks

Building blocks are how you **bootstrap a project fast**. A block is a
self-contained bundle — data objects, relationships, seed data, scheduled
tasks, roles, event subscriptions, and (optionally) **vendored business
logic** — packaged as a validated **manifest** that the server applies through
its own APIs. Because a block creates real objects, REST/GraphQL/MCP light up
for it instantly, with no extra wiring.

The model is deliberately shadcn-style: you install a block into *your*
project and you own the result. Blocks are not a runtime dependency you're
locked into — they're a starting point you can modify freely.

## The mental model

```
registry / URL / local path          ┌────────────────────────────┐
        │                            │  Ion Drive server          │
        ▼                            │  BlockEngine → Schema/     │
┌──────────────┐  1. code/ files     │  Data/Task/Role APIs       │
│ ion-drive add│ ───▶ blocks/<name>/ └────────────────────────────┘
│              │  2. manifest  POST /api/v1/blocks/install  ▲
└──────────────┘                                            │
                        objects · relationships · seed · tasks ·
                        roles · subscriptions · actions · hooks
```

Installing is a **two-part operation** (ADR-018):

1. **Code is vendored** — the block's TypeScript (if any) is copied into your
   project at `blocks/<name>/` and wired into the `blocks/index.ts` barrel.
   From that moment it's your code: edit freely, the dev server hot-reloads,
   re-`add` never overwrites your edits.
2. **The manifest is installed** — POSTed to the server, which validates it
   (including that every declared action/hook has a registered handler — the
   `requires` contract), applies the schema, and records the `_ion_blocks`
   ledger.

The **block runtime** in `@ion-drive/core` is *content-agnostic* — it
installs any validated manifest it's handed.

## Official catalog & registries

Official blocks live in the separate
[`jaredgrabill/ion-drive-blocks`](https://github.com/jaredgrabill/ion-drive-blocks) repository — one
directory per block, distributed through the exact same pipeline a third-party
block uses: a **protocol-v1 registry** (static JSON — a small `index.json`
directory plus one `blocks/<name>.json` version history per block; see
[Block Registries](block-registries.md)).

| Block | Contents | Depends on | Logic |
|:---|:---|:---|:---|
| `crm` | Contacts, Companies, Deals, Activities | — | — |
| `invoicing` | Invoices, Line Items, Payments | `crm: ^0.2.0` | Stripe payment links + webhook (`code/`) |
| `catalog` | Products, prices, stock moves | `invoicing: ^0.1.0` | Stock adjustment + invoice-line pricing (`code/`) |
| `communications` | Message log, templates, campaigns | — | — |
| `audit` | `audit_log` fed by the message bus | — | — |

Projects configure registries as **namespaces** in `ion.config.json`
(spec-03); the official registry `@ion` is built in and is the default for
bare refs:

```json
{
  "registries": {
    "@acme": {
      "url": "https://blocks.acme.internal/registry/index.json",
      "headers": { "Authorization": "Bearer ${ACME_REGISTRY_TOKEN}" }
    }
  },
  "defaultRegistry": "@ion"
}
```

Dependencies are resolved recursively across registries — semver ranges are
collected over the whole closure and the **highest version satisfying every
range** is picked; the plan is applied in topological order with
already-installed blocks pruned. A block's bare dependency names resolve in
the registry *that block* came from, never your default (the
anti-dependency-confusion rule). `ION_DRIVE_REGISTRY` still overrides the
default registry's URL for one invocation. (The legacy `registryUrl` config
field is no longer read — declare the URL under `registries` instead.)

## Manifest versioning

Manifest **v1** (spec-02) uses real semver semantics:

- **`version`** is a strict, canonical semver version (`0.2.0`,
  `1.0.0-rc.1`). No `v` prefix, no build metadata — anything
  `semver.valid` would normalise away is rejected.
- **`dependencies`** is a **name → semver-range record**, not an array:
  `{ "crm": "^0.2.0" }`. `"*"` is the unconstrained escape hatch. Refs may be
  namespaced (`"@acme/billing": "^1.2"`) — a namespace names a *registry
  source*, never a separate identity, so the server matches by bare name.
- **`requires.core`** is a semver range the running core version must satisfy
  (e.g. `">=0.2.0 <1.0.0"`), checked before anything is applied.

Blocks are **singletons per server** — exactly one version of a block is
installed at a time, so ranges are compatibility *constraints* the installer
checks, never an npm-style multi-version solver problem.

## Installing with the CLI

```bash
npx ion-drive list                    # the default registry's catalog
npx ion-drive list --all              # every configured registry
npx ion-drive add crm                 # bare ref → the default registry's latest
npx ion-drive add crm@0.1.0           # exact version
npx ion-drive add crm@^0.2            # semver range (highest satisfying wins)
npx ion-drive add @acme/billing@1.x   # namespaced ref → the @acme registry
npx ion-drive add https://…/block.json  # direct URL
npx ion-drive add ../blocks/invoicing # local path (the block-dev loop)
npx ion-drive remove invoicing        # uninstall (your vendored code stays)
npx ion-drive registry list           # configured registries + staleness
```

Useful flags:

- `--dry-run` — preview the changes without applying them.
- `--force` — reinstall even if already present (idempotent: existing objects,
  relationships, and files are skipped; ledger ownership is preserved), and
  proceed through installed-version range conflicts.
- `--no-cache` — bypass the 5-minute registry metadata cache.
- `remove --drop-data` — also drop tables that still have rows.

Each install is recorded in `ion.config.json`'s `blocks[]`
(`name`/`version`/`digest`/`source`/`sourceUrl`/`installedAt`) — the
project's lockfile-equivalent.

For a block with vendored code, `add` waits for your dev server (tsx watch) to
reload the new handlers before installing the manifest — so run it with
`npm run dev` active. `remove` uninstalls the schema and unwires the barrel,
but never deletes `blocks/<name>/` — that code is yours now.

## Integrity and trust

Every registry install is **digest-verified** (spec-04): the CLI computes
`sha256:<hex>` over the exact fetched artifact bytes and compares it with the
registry-declared digest for that version *before* anything is parsed,
vendored, or sent to the server. A mismatch aborts the **whole** plan with no
`--force` override — a poisoned artifact is never "forced". Direct-URL
installs have no declared digest; the computed one is printed once so you can
pin it. Local paths hash the bytes the CLI itself packs. The verified digest
is recorded in `ion.config.json` and in the server's `_ion_blocks` ledger.

On top of digest integrity sits **provenance**: publishers can attach a
[sigstore](https://sigstore.dev) attestation bundle produced by GitHub's
artifact attestations. The CLI computes one of three trust tiers — never
taken from the registry's self-asserted `trust` field, which is a display
hint only (shown as "(claimed)" in `ion-drive list`):

| Tier | Badge | Meaning |
|:--|:--|:--|
| `official` | `◆ official` | Attestation verified AND built from `jaredgrabill/ion-drive-blocks` |
| `verified` | `✔ verified · github.com/acme/blocks` | Attestation verified against the repo the registry claims |
| `community` | `○ community (unattested)` | No bundle, failed/unavailable verification, or local/URL source |

**Attestation proves where the code was built, not that it is safe.** A
verified badge means "these exact bytes were built by that repository's CI" —
review the vendored code regardless (it lands readable in your tree;
`add --show-code` lists every file with its size and sha256 before the
confirm prompt). An *absent* bundle is a warning; a *present-but-invalid*
bundle is a loud warning (it can indicate tampering) — `add` still proceeds
because the digest already protects integrity, while `ion-drive block verify`
exits non-zero. `--no-verify-provenance` skips attestation checks (e.g.
offline environments, which otherwise degrade to `community` with a warning);
the digest check is never skippable.

Audit any published block without installing it:

```bash
ion-drive block verify crm@0.2.0            # digest + attestation + tier verdict
ion-drive block verify crm --against-installed  # ledger digest vs registry digest
ion-drive block verify crm --json            # machine-readable verdict
```

`--against-installed` catches "the registry mutated after I installed" and
"someone installed different bytes on this server" by comparing the server
ledger's recorded digest with the registry's for the installed version.

## Installing over HTTP

Blocks are also a plain REST surface under **`/api/v1/blocks`** (RBAC resource
`blocks`, gated by `ION_BLOCKS_ENABLED`):

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/v1/blocks` | List installed blocks (the `_ion_blocks` ledger) |
| `GET` | `/api/v1/blocks/:name` | Inspect one installed block |
| `GET` | `/api/v1/blocks/actions` | Declared actions/hooks + registered handlers |
| `POST` | `/api/v1/blocks/preview` | Validate + preview a manifest |
| `POST` | `/api/v1/blocks/install` | Install a manifest (`?dryRun`, `?force`; body is a bare manifest or `{ manifest, source }`) |
| `POST` | `/api/v1/blocks/:block/actions/:action` | Invoke a block action |
| `DELETE` | `/api/v1/blocks/:name` | Uninstall (`?dropData`) |

Installation is **step-wise and idempotent-friendly** — existing objects are
skipped and reported rather than duplicated — and **dependency, requirement,
and data-loss guards are enforced server-side**, not just in the CLI:

- A missing dependency fails `422` (`code: DEPENDENCY`); a dependency
  installed at a version **outside the declared range** fails `422` with
  `code: DEPENDENCY_VERSION`, naming the installed version and the required
  range.
- An unsatisfied `requires.core` fails `400`, naming the running core version
  and the declared range.
- `?force=true` downgrades both range failures to warnings in the install
  report (the ADR-017 force contract); `?dryRun=true` reports them as
  warnings without failing.
- The optional `source` envelope member is **client-asserted provenance**
  (registry, artifact URL, verified digest, attested flag, publisher, tier)
  stored in the `_ion_blocks` ledger and returned by the `GET` endpoints —
  audit metadata for incident response, not a server-side security control.
  Unknown `source` keys fail `400`.

Actions and inbound webhooks are documented in
[Actions & hooks](../api/actions.md).

## Authoring a block

Scaffold the standard layout, validate against the platform's Zod schema, and
pack the distributable artifact:

```bash
ion-drive block new my-block      # ./block-my-block/{block.json, code/, CI}
cd block-my-block
# …edit block.json (+ code/ if the block ships logic)…
ion-drive block validate          # platform schema + structural code checks
ion-drive block pack              # dist/<version>/block.json with code/ embedded
```

```
block-my-block/
  block.json                # the manifest — source of truth
  code/                     # vendored TypeScript (index.ts default-exports a definePlugin)
  dist/<version>/block.json # immutable packed artifact — what a registry serves
```

Test against a real project without publishing anything:

```bash
cd ../my-app && ion-drive add ../block-my-block
```

A block that declares `actions`/`hooks` must ship `code/` whose plugin
registers matching handlers (`ctx.actions.registerAction/registerHook`) —
install fails with an actionable error otherwise. Keep vendored code **thin
and heavily commented**: call `DataService`/`SecretsManager`/platform APIs,
never re-implement plumbing. LLM legibility is a product goal.

## Publishing a block

A registry is a **git repo of block directories plus generated protocol-v1
JSON** — GitHub Pages/S3/nginx serve it; no server required. Two commands run
the whole publish side (spec-05):

```bash
ion-drive registry build [dir]    # the generator: validate every */block.json,
                                  # pack missing dist/<version>/ artifacts,
                                  # regenerate registry/blocks/*.json + index.json
ion-drive registry build --check  # CI drift guard: fails on any would-be change
ion-drive block publish           # clone a registry repo → copy this block in →
                                  # build there → open a PR (--direct pushes)
```

The generator is **append-only**: released `(name, version)` artifacts and
version entries are immutable — any mutation is a named refusal, and fixing
anything means bumping the version. A `registry.config.json` at the registry
repo's root supplies the registry's identity (`name`, plus the `repository`
stamped on every block doc — the claim attestations are verified against).
`block publish` reads its default target repo from
`meta.publishConfig.registryRepo` in `block.json`, or takes
`--registry-repo <owner/repo | git URL | local path>`.

Provenance comes from CI, not from your laptop: the official repo's reusable
workflow (`publish-block.yml`) packs new versions on merge to `main`, attests
each artifact with GitHub artifact attestations (sigstore — that's what makes
`ion-drive add` show `◆ official` / `✔ verified`), and commits the result.
**Publishing locally cannot attest provenance** — a locally-pushed version is
`community` until the registry repo's CI attests it, the same incentive
structure npm uses.

Mutable-status administration (in a registry checkout, then commit + PR):

```bash
ion-drive registry yank crm@0.2.0 --reason "corrupts pipeline stages"
ion-drive registry deprecate crm@0.1.0 --reason "superseded by 0.2.0"
```

Yanked versions are never *selected* by resolvers (exact re-installs of a
version recorded in your project keep working, loudly warned); deprecated
versions install with a warning. The official repo's full operating procedures
live in its `docs/registry-operations.md`.

See [ADR-013, ADR-018, and ADR-022](../research/architecture-decisions.md)
for the design rationale.
