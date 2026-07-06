---
name: new-block
description: Workflow for authoring or modifying a catalog building block — manifest, registry, emit, drift guard, docs, and live install verification.
---

# Authoring a catalog building block

Read these first, every time:

- `packages/core/src/blocks/block-types.ts` — `blockManifestSchema` (the authoritative Zod
  schema) and `BlockManifestInput` (the authoring type).
- `packages/core/src/blocks/block-manifest.ts` — `parseManifest` (validation + referential
  checks: seed keys, relationship endpoints).
- An existing manifest, e.g. `packages/blocks/src/blocks/crm.ts`, for shape and style.

## What a manifest can declare

`objects` (fields with constraints/defaults), `relationships`, `seed` (keyed by object
name), `tasks` (cron definitions), `roles` (permission grants), and `subscriptions`
(`{ event, consumer, handler, perInstance?, config? }` message-bus hooks — see the `audit`
block). Cross-block needs go in `dependencies` (e.g. invoicing depends on crm); the CLI
resolver and the server both enforce them.

## The `managedBy` contract

Do **not** set provenance by hand. The installer stamps `managedBy: 'block:<name>'` on
every object, field, and relationship FK field it creates (via the manifest→ChangeSet
converters in `block-types.ts`). That provenance powers contract protection (structural
changes to block fields are rejected without `?force=true`), uninstall cleanup, and drift-
doctor severity escalation. Users may still add their own fields to block objects — that's
the point.

## Workflow

1. **Author** `packages/blocks/src/blocks/<name>.ts` ending in `satisfies
   BlockManifestInput` — TypeScript is the source of truth, compiler-checked.
2. **Register** in `packages/blocks/src/registry.ts`: add the import, the `blocks` map
   entry, **and** the `blockRegistry` array entry. The CLI needs no separate change —
   `packages/cli/src/registry/registry-client.ts` imports the bundled catalog straight from
   `@ionshift/ion-drive-blocks`.
3. **Emit** the distributable JSON:
   ```bash
   pnpm --filter @ionshift/ion-drive-blocks emit
   ```
   writes `packages/blocks/blocks/<name>/block.json` — commit it.
4. **Drift guard**: `pnpm --filter @ionshift/ion-drive-blocks test` —
   `packages/blocks/src/manifests.test.ts` asserts every manifest passes `parseManifest`
   and that each committed `block.json` exactly matches its TS source. Add any
   block-specific assertions (e.g. the dependency check invoicing has) here.
5. **Docs — the step that historically drifts** (the `audit` block was missing from the
   catalog list for a whole phase; roadmap F4). Update the catalog enumeration in:
   - `docs/getting-started.md` (the `ion-drive list` comment in the blocks section)
   - `README.md` (both the Building Blocks feature bullet and the repo-layout tree line)
6. **Live verify** against a running server (see the `live-smoke` skill for boot/auth):
   - Preview first: `POST /api/v1/blocks/install?dryRun=true` with the manifest (or
     `{ "manifest": … }`) — returns the install report without touching the DB.
   - Real install: `POST /api/v1/blocks/install` (201). Dependencies must already be
     installed — the server enforces the graph; the CLI (`ion-drive add <name>`) resolves
     them client-side in topological order.
   - Confirm the objects light up on REST/GraphQL/MCP with zero extra wiring, and seed
     rows exist.
   - Uninstall: `DELETE /api/v1/blocks/:name` (add `?dropData=true` to drop tables);
     verify the dependent-block and data-loss guards fire when they should.

## Definition of done

Manifest validates, `block.json` committed and drift test green, registry + CLI `list`
show it, both docs mention it, and a live install → uninstall cycle passed.
