---
name: new-block
description: Workflow for authoring or modifying an official building block — manifest, vendored code, pack, registry index, docs, and live install verification.
---

# Authoring an official building block

Official blocks live in the **separate `jaredgrabill/ion-drive-blocks` repo** (locally at
`I:\ion-shift\blocks`), one directory per block — NOT in this monorepo
(packages/blocks retired in Phase 14, ADR-018 re-amendment). Read these first:

- `packages/core/src/blocks/block-types.ts` — `blockManifestSchema` (the authoritative Zod
  schema, incl. Phase 14 `actions`/`hooks`/`requires`/`code`).
- `packages/core/src/blocks/action-registry.ts` — the handler contract vendored code
  registers against (`registerAction`/`registerHook`).
- An existing block, e.g. `I:\ion-shift\blocks\invoicing\` (the vendored-logic exemplar).

## Block layout (same for official and third-party)

```
<name>/
  block.json        # manifest — source of truth (objects, actions, hooks, requires)
  code/             # vendored TS, only when the block ships logic; index.ts default-exports definePlugin
  dist/block.json   # packed artifact (code embedded) — what the registry serves
```

## Rules

- **Manifests declare, code provides.** Every declared action/hook must be registered by
  `code/index.ts`'s plugin `setup` — install fails actionably otherwise. Keep vendored code
  **thin and heavily commented** (call DataService/SecretsManager; never re-implement
  plumbing; LLM legibility is a product goal).
- **`managedBy` provenance is stamped by the installer** — never by hand.
- Secrets via `ctx.secrets.get(...)`; document required keys in `meta.secrets`.

## Workflow

1. **Scaffold**: `ion-drive block new <name>` (or copy an existing dir in `jaredgrabill/ion-drive-blocks`).
2. **Author** `block.json` (+ `code/` if logic). Cross-block needs → `dependencies`.
3. **Validate**: `ion-drive block validate <dir>` (platform Zod schema + code checks).
4. **Block test (required before any registry entry)**: `ion-drive block test <dir>
   --deps-from I:\ion-shift\blocks` (spec-06) — boots an ephemeral server on a scratch DB,
   installs for real, asserts (install report, data endpoints, action reachability,
   uninstall-leaves-no-residue), and runs the block's own `test/*.test.ts` under the
   `ION_TEST_SERVER_URL`/`ION_TEST_API_KEY` env contract. Add `test/fixtures.json` action
   inputs/seed checks where useful. Must be green; the blocks-repo CI runs the same loop.
5. **Pack**: `ion-drive block pack <dir>` → commit `dist/<version>/block.json` (CI drift-guards it).
6. **Register**: `ion-drive registry build` in the blocks repo regenerates
   `registry/blocks/<name>.json` + `registry/index.json` (append-only; spec-05).
7. **Docs**: update the catalog tables in `docs/concepts/building-blocks.md` and, if
   user-facing, `README.md` + `docs/getting-started.md` in the platform repo.
8. **Live verify** from a scaffolded project (`ion-drive init`, `npm run dev` running):
   - `ion-drive add ../blocks/<name>` (local path — the block-dev loop). For logic blocks,
     confirm: code vendored to `blocks/<name>/`, barrel wired, handlers awaited, install
     passes `requires` validation.
   - Objects live on REST/GraphQL/MCP; actions appear in `/api/v1/openapi.json`, in
     `GET /api/v1/blocks/actions`, and as MCP `<block>_<action>` tools.
   - Hooks respond at `/api/v1/hooks/<block>/<hook>` (signature-verified, session-exempt).
   - `ion-drive remove <name>` honors data guards; barrel unwired; vendored files kept.

## Definition of done

Validate + **block test** + pack green, registry JSON regenerated, docs mention it, and
the full local-path add → invoke → remove cycle passed against a scaffolded project.
No block enters the registry without a green `ion-drive block test`.
