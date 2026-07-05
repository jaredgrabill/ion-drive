# @ionshift/ion-drive-blocks

Ion Drive's official **building blocks** — ready-made business domains you install
into a running instance with the CLI:

```bash
ion-drive add crm
ion-drive add invoicing   # depends on crm — resolved automatically
ion-drive add communications
```

Blocks are distributed **shadcn-style**: each is a self-contained manifest
(`blocks/<name>/block.json`) describing the data objects, relationships, seed
data, scheduled tasks, and RBAC roles it materialises. Installing a block runs
those through the same schema/data/task/role APIs a human uses — so REST,
GraphQL, and MCP light up for the block's objects instantly. You own the
resulting schema and can edit it freely afterward.

## Bundled blocks

| Block | Objects | Depends on |
|:--|:--|:--|
| `crm` | Companies, Contacts, Deals, Activities | — |
| `invoicing` | Invoices, Line Items, Payments | `crm` |
| `communications` | Email Templates, Notifications | — |

## Authoring

The `.ts` files under `src/blocks/` are the source of truth — they are typed as
`BlockManifestInput` from `@ionshift/ion-drive-core`, so the compiler validates every
column type and shape. Run `pnpm --filter @ionshift/ion-drive-blocks emit` to regenerate
the distributable `block.json` files from the TypeScript. A test asserts the two
never drift.

## License

MIT — see [LICENSE](LICENSE). Trademark notice: IonShift, Ion Drive, and related
marks are trademarks of IonShift Technologies LLC. See the [NOTICE](../../NOTICE)
file in the repo root for full trademark terms.
