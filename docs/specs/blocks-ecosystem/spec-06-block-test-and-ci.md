# Spec 06 — `block test`, the Regenerated Scaffold, and `ion-drive audit`

**Lands in:** `jaredgrabill/ion-drive` (`packages/cli`) + `jaredgrabill/ion-drive-blocks`
(CI adoption).
**Depends on:** spec-02 (manifest v1); spec-05 (publish workflow templates referenced by
the scaffold). Parallel with spec-07.

## Scope

The testing leg of the SDLC: `ion-drive block test` (boot an ephemeral server, install
the block for real, assert, run the block's own tests), the regenerated `block new`
scaffold (CI + publish workflow templates, README, test skeleton), and `ion-drive audit`
(check installed blocks against registries for advisories/yanks/digest drift).

## Non-goals

- Unit-testing vendored code in isolation (blocks may do that themselves; the scaffold's
  test skeleton shows how) — this spec's value is the *install-and-run* loop nothing
  else covers.
- Testcontainers or any Docker orchestration dependency — Postgres availability is the
  caller's job (documented), matching the core repo's integration-suite convention
  (scratch databases on a provided Postgres).

## Design

### 1. `ion-drive block test [dir]`

```
ion-drive block test [dir]
  --server <url>       # test against an existing server instead of booting one
  --keep               # keep the temp project + database for debugging
  --json
  # ephemeral mode connection: ION_DATABASE_URL env or --database-url (server-owner DSN)
```

**Ephemeral mode (default):**

1. Read + `parseManifest` the block (fail fast).
2. Create scratch database `ion_blocktest_<rand>` on the provided Postgres (the core
   integration suite's `CREATE DATABASE ion_it_*` pattern — reuse its approach, not its
   code).
3. Scaffold a temp project (reuse `project-scaffold.ts` internals in a minimal mode: no
   git, no compose, deps resolved from the CLI's own tree via `file:`/module paths —
   implementation may instead boot core programmatically via `createServer()` imported
   project-first, which is simpler and is the **recommended** route: no `npm install` in
   the loop).
4. Vendor the block's `code/` and register its plugin exactly as `add` would (barrel
   entry → `createServer(cfg, { plugins: [blockPlugin] })`).
5. Install dependencies first (resolved from the configured registry — network — or
   `--deps-from <dir>` for offline monorepo-style testing of co-developed blocks), then
   the block itself from the local path (dry-run first, then real).
6. **Assertions (the built-in suite):**
   - Install report clean: every declared object/relationship/task/role/subscription/
     webhook/action/hook created or explainably skipped; `requires` satisfied.
   - Registry reality: each object answers `GET /api/v1/data/<object>` (empty or seeded
     list); seeds row-counted.
   - Each declared action invokes via `POST /api/v1/blocks/<name>/actions/<action>`
     with the fixture input (below); anything but a handler-level failure passes
     (a 400 from the action's own Zod is a *pass* for `{}` when no fixture exists —
     the assertion is "wired and reachable", not "business-correct").
   - Uninstall (`DELETE /api/v1/blocks/<name>`) succeeds; `--drop-data` leaves no
     orphan tables (doctor check).
7. Run the block's own tests if `test/` exists: `node --test test/` with env
   `ION_TEST_SERVER_URL`, `ION_TEST_API_KEY` (a `manage`-all key created for the run) —
   plain node test runner, zero framework lock-in.
8. Teardown (drop DB, delete temp dir) unless `--keep`. Non-zero exit on any failure;
   `--json` emits the assertion report.

**Fixtures:** optional `test/fixtures.json` in the block dir:
`{ "actions": { "<action>": { "input": {…}, "expectStatus": 200 } }, "seedChecks": … }`.
Keep the schema tiny; it can grow.

**`--server <url>` mode:** skip 2–4; install/assert/uninstall against the given server
(CI-with-service-container mode; also the fastest inner loop against `ion-drive dev`).
Refuses servers that report existing user objects unless `--force` (don't trash a real
instance by accident); always confined to the block's own names.

### 2. Regenerated `block new` scaffold

`packages/cli/src/commands/block.ts` templates become:

```
block-<name>/
  block.json                    # $schema → block-manifest.v1.json; requires.core preset
  code/index.ts                 # definePlugin skeleton (unchanged spirit)
  test/
    fixtures.json               # empty skeleton
    smoke.test.ts               # example node:test hitting ION_TEST_SERVER_URL
  README.md                     # dev-loop docs: add ../block-x, block test, publish
  .github/workflows/
    ci.yml                      # validate → pack → block test (Postgres service) → drift
    publish.yml                 # thin caller of the reusable publish workflow (spec-05),
                                # commented variants: own-repo registry vs PR-to-registry
  .gitignore
```

`ci.yml` template (the important part): a `services: postgres:17` container,
`npm i -g @ion-drive/cli @ion-drive/core`, `ion-drive block validate .`,
`ion-drive block pack .`, `ion-drive block test . --database-url
postgres://postgres:postgres@localhost:5432/postgres`, drift guard on `dist/`.

Official repo CI (`ion-drive-blocks/ci.yml`) adopts the same `block test` step per
block (glob loop, per spec-05 §4).

### 3. `ion-drive audit`

Reads `ion.config.json.blocks[]` (and, when a server is configured, the live ledger) and
reports, per installed block:

- **Advisories** matching the installed version (registry `advisories[]`,
  `affectedVersions` range).
- **Status**: installed version now `yanked`/`deprecated`.
- **Updates**: newer satisfying version available (informational).
- **Digest drift**: registry's digest for the installed version ≠ recorded digest
  (⇒ registry mutated a release — loud).
- **Ledger drift** (server mode): ledger version/digest ≠ config record (someone
  changed the server out-of-band).

Exit codes: 0 clean, 1 advisories/yanks/drift found (CI-friendly); `--json`. Local-path
and URL-sourced blocks are listed as "unauditable source" (informational). The scaffolded
*project* CI (from `ion-drive init`, `project-scaffold.ts`) gains an `ion-drive audit`
step — the ecosystem's Dependabot-lite.

## Implementation notes (files)

- `packages/cli/src/commands/block.ts` — `test` subcommand + template regeneration
  (extract templates to `src/templates/` if the file gets unwieldy; it already hosts
  BLOCK_CI etc.).
- New `packages/cli/src/block-test/` — runner (`runner.ts`: lifecycle;
  `assertions.ts`: the built-in suite; pure/injectable where feasible, but this is
  integration tooling — bias to clarity over mockability).
- `packages/cli/src/commands/audit.ts` — new; registry reads via the spec-03 client.
- `packages/cli/src/project-scaffold.ts` — project CI template gains audit.
- `ion-drive-blocks/.github/workflows/ci.yml` — adopt `block test`.
- Docs: `docs/concepts/building-blocks.md` "Testing a block" + "Auditing installs"
  sections; block README template covers the loop; `new-block` skill updated to require
  a green `block test` before registry entry.

## Acceptance criteria

1. `block test` on each of the five official blocks passes green in ephemeral mode on a
   bare Postgres (Windows dev box and Linux CI both).
2. A deliberately broken fixture block (action declared, handler never registered) fails
   with the installer's actionable error surfaced; a block whose uninstall leaves an
   orphan junction table fails the doctor assertion.
3. `--server` mode refuses a server with user objects without `--force`; with a fresh
   server it passes and leaves zero residue (objects, roles, tasks, webhooks all gone).
4. Block-local `test/*.test.ts` runs with the env contract; its failure fails the
   command.
5. `audit` flags: a fixture advisory hit, a yanked install, a digest-drift fixture, and
   exits 1; clean project exits 0; `--json` stable shape.
6. `block new` output passes its own scaffolded CI (validate/pack/test/drift) in a
   scratch repo with the published CLI — the dogfood loop.

## Test plan

- Unit: fixtures schema parse; audit report assembly against fake registries/config;
  template snapshot tests (existing scaffold-shape suite pattern in `packages/cli`).
- Integration-by-command: a vitest suite that shells `ion-drive block test` against the
  repo's own Postgres (guarded by the same env the core integration suite uses) for one
  fixture block.
- The official-repo CI adoption is the live verification.
