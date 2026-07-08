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

## Official catalog & the registry

Official blocks live in the separate
[`jaredgrabill/ion-drive-blocks`](https://github.com/jaredgrabill/ion-drive-blocks) repository — one
directory per block, distributed through the exact same pipeline a third-party
block uses: a flat **registry index** (`registry/index.json`) maps
`name → version → artifact URL`.

| Block | Contents | Depends on | Logic |
|:---|:---|:---|:---|
| `crm` | Contacts, Companies, Deals, Activities | — | — |
| `invoicing` | Invoices, Line Items, Payments | `crm` | Stripe payment links + webhook (`code/`) |
| `communications` | Message log, templates, campaigns | — | — |
| `audit` | `audit_log` fed by the message bus | — | — |

Dependencies are resolved recursively (topological order, already-installed
blocks pruned) before anything is applied. Override the registry with the
`ION_DRIVE_REGISTRY` env var or `registryUrl` in `ion.config.json`.

> The registry wire format is moving to **protocol v1** (versioned, digest-verified,
> multi-registry — ADR-022): see [Block Registries](block-registries.md).

## Installing with the CLI

```bash
npx ion-drive list                    # the registry catalog
npx ion-drive add crm                 # by name (resolves the registry index)
npx ion-drive add crm@0.1.0           # pinned version
npx ion-drive add https://…/block.json  # direct URL
npx ion-drive add ../blocks/invoicing # local path (the block-dev loop)
npx ion-drive remove invoicing        # uninstall (your vendored code stays)
```

Useful flags:

- `--dry-run` — preview the changes without applying them.
- `--force` — reinstall even if already present (idempotent: existing objects,
  relationships, and files are skipped; ledger ownership is preserved).
- `remove --drop-data` — also drop tables that still have rows.

For a block with vendored code, `add` waits for your dev server (tsx watch) to
reload the new handlers before installing the manifest — so run it with
`npm run dev` active. `remove` uninstalls the schema and unwires the barrel,
but never deletes `blocks/<name>/` — that code is yours now.

## Installing over HTTP

Blocks are also a plain REST surface under **`/api/v1/blocks`** (RBAC resource
`blocks`, gated by `ION_BLOCKS_ENABLED`):

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/v1/blocks` | List installed blocks (the `_ion_blocks` ledger) |
| `GET` | `/api/v1/blocks/:name` | Inspect one installed block |
| `GET` | `/api/v1/blocks/actions` | Declared actions/hooks + registered handlers |
| `POST` | `/api/v1/blocks/preview` | Validate + preview a manifest |
| `POST` | `/api/v1/blocks/install` | Install a manifest (`?dryRun`, `?force`) |
| `POST` | `/api/v1/blocks/:block/actions/:action` | Invoke a block action |
| `DELETE` | `/api/v1/blocks/:name` | Uninstall (`?dropData`) |

Installation is **step-wise and idempotent-friendly** — existing objects are
skipped and reported rather than duplicated — and **dependency, requirement,
and data-loss guards are enforced server-side**, not just in the CLI.

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
ion-drive block pack              # dist/block.json with code/ embedded
```

```
block-my-block/
  block.json        # the manifest — source of truth
  code/             # vendored TypeScript (index.ts default-exports a definePlugin)
  dist/block.json   # packed artifact — what a registry serves
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

See [ADR-013 and ADR-018](../research/architecture-decisions.md) for the
design rationale.
