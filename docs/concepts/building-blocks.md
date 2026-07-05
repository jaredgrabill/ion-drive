# Building Blocks

Building blocks are how you **bootstrap a project fast**. A block is a
self-contained bundle — data objects, relationships, seed data, scheduled tasks,
and roles — packaged as a validated **manifest** that the server applies through
its own APIs. Because a block creates real objects, REST/GraphQL/MCP light up
for it instantly, with no extra wiring.

The model is deliberately shadcn-style: you install a block into *your* server
and you own the result. Blocks are not a runtime dependency you're locked into —
they're a starting point you can modify freely.

## The mental model

```
┌─────────────┐   manifest    ┌──────────────────────────┐
│  CLI / URL  │ ────────────▶ │  Ion Drive server        │
│  (catalog)  │   POST        │  BlockEngine → Schema/    │
└─────────────┘  /api/v1/     │  Data/Task/Role APIs      │
                  blocks/     └──────────────────────────┘
                  install               │
                                        ▼
                          objects · relationships · seed
                          data · tasks · roles  (all live)
```

The **block runtime** in `@ionshift/ion-drive-core` is *content-agnostic* — it installs
any validated manifest it's handed. The **official catalog** lives separately in
`@ionshift/ion-drive-blocks`, and remote/self-hosted registries can serve manifests by
URL.

## Official catalog

| Block | Contents | Depends on |
|:---|:---|:---|
| `crm` | Contacts, Companies, Deals, Activities | — |
| `invoicing` | Invoices, Line Items, Payments | `crm` |
| `communications` | Email templates, notifications | — |

Dependencies are resolved recursively (topological order, already-installed
blocks pruned) before anything is applied.

## Installing with the CLI

```bash
# 1. Point the CLI at your server (writes ion.config.json; offers a client starter)
npx ion-drive init

# 2. Browse the catalog
npx ion-drive list

# 3. Install a block and its dependencies
npx ion-drive add crm
npx ion-drive add invoicing     # pulls in crm automatically

# 4. Remove a block
npx ion-drive remove invoicing
```

Useful flags:

- `ion-drive add <block> --dry-run` — preview the changes without applying them.
- `ion-drive add <block> --force` — reinstall even if already present.
- `ion-drive remove <block> --drop-data` — also drop tables that still have rows.
- `ion-drive add <url>` — install a manifest from a remote registry URL.

The CLI keeps a local mirror of installed blocks in `ion.config.json`, so your
block set is checked in alongside your code.

## Installing over HTTP

Blocks are also a plain REST surface under **`/api/v1/blocks`** (RBAC resource
`blocks`, gated by `ION_BLOCKS_ENABLED`):

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/v1/blocks` | List installed blocks (the `_ion_blocks` ledger) |
| `GET` | `/api/v1/blocks/:name` | Inspect one installed block |
| `POST` | `/api/v1/blocks/preview` | Validate + preview a manifest |
| `POST` | `/api/v1/blocks/install` | Install a manifest (`?dryRun`, `?force`) |
| `POST` | `/api/v1/blocks/:name/uninstall` | Uninstall (`?dropData`) |

Installation is **step-wise and idempotent-friendly** — existing objects are
skipped and reported rather than duplicated — and **dependency + data-loss
guards are enforced server-side**, not just in the CLI. The `_ion_blocks` ledger
records the manifest snapshot and the objects a block created, so uninstall is
clean.

## Authoring a block

Manifests are authored in TypeScript for compiler-checked safety
(`satisfies BlockManifestInput`) and emitted to distributable `block.json`:

```ts
import type { BlockManifestInput } from '@ionshift/ion-drive-core';

export const crm = {
  name: 'crm',
  version: '0.1.0',
  displayName: 'CRM',
  description: 'Contacts, companies, deals, and activities.',
  dependencies: [],
  objects: [ /* DataObjectDefinition[] */ ],
  relationships: [ /* … */ ],
  seed: { /* object -> rows */ },
  tasks: [ /* task definitions */ ],
  roles: [ /* role grants */ ],
} satisfies BlockManifestInput;
```

Run `pnpm --filter @ionshift/ion-drive-blocks emit` to write the `block.json` files (a
test guards against drift between the TypeScript source and the emitted JSON).

See [ADR-013](../research/architecture-decisions.md) for the design rationale.
