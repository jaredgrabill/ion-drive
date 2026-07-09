# Spec 07 — `ion-drive diff` and `ion-drive update`: the Block Update Story

**Lands in:** `jaredgrabill/ion-drive` (`packages/cli` + `packages/core`).
**Depends on:** spec-02 (semver), spec-04 (digests/ledger). Parallel with spec-06.
Closes the slipped Phase-14 Tier 3D stretch item (`ion-drive diff`), which the ledger's
manifest snapshot was designed for (ADR-018).

## Scope

Updating an installed block to a newer version without violating ADR-018's ownership
contract ("the vendored code is yours; never auto-overwrite"): a three-way diff command,
an apply command with the `.new`-file convention for user-modified files, and the
server-side installer **upgrade mode** that applies manifest deltas safely.

## Non-goals

- Automatic merges of user-edited code (never — ADR-018).
- Downgrades (`update` refuses to target a lower version; recovery is uninstall +
  reinstall, documented).
- Data migrations beyond what the schema engine's validated pipeline already provides
  (backfills etc. surface as the standard preview warnings).

## Design

### 1. The three inputs

For installed block `<name>` at version `A`, target version `B` (default: highest
satisfying, active, non-prerelease version from the block's recorded `source` registry):

1. **Old truth** — the ledger row (`GET /api/v1/blocks/<name>`): manifest snapshot as
   installed (including its `code[]` — the pristine vendored bytes) + version + digest.
2. **New truth** — the fetched, digest-verified artifact for `B` (spec-04 path).
3. **User's tree** — `blocks/<name>/**` in the working directory.

### 2. `ion-drive diff <name> [--version <selector>] [--json]`

Output, in order:

**Manifest delta** (computed structurally, not textually): objects/fields/relationships/
tasks/roles/subscriptions/webhooks/actions/hooks added / removed / changed, each line
classified `additive` | `destructive` | `modifying` (rename/type change). Reuses the
schema-engine vocabulary (ChangePreview terms) so it reads like the designer's previews.

**Code file status**, per path in old ∪ new `code[]` ∪ tree:

| Status | Meaning (byte comparison) |
|---|---|
| `unchanged` | new == old == tree — nothing to do |
| `update available` | new ≠ old, tree == old (user never touched it) — safe overwrite |
| `modified by you` | tree ≠ old — show upstream diff (old→new unified diff), never write |
| `added upstream` | in new only — will be created |
| `removed upstream` | in old only — will be reported, never deleted |
| `yours` | in tree only (user-created file) — untouched |

The `tree == old` test uses the ledger snapshot's bytes (exactly why the snapshot
exists); no hashes-in-files or metadata tricks.

**Trailer:** target version's trust badge + digest, `requires.core` check against the
server, dependency-range implications (does `B` need dep updates? — resolved via the
spec-03 resolver, reported, not applied).

### 3. `ion-drive update <name> [--version <selector>] [--yes] [--force]`

1. Run the full diff; render it; confirm (unless `--yes`).
2. **Dependencies first:** if `B`'s ranges require dep updates, refuse with the ordered
   plan ("run: ion-drive update crm — then retry"); `--with-deps` performs them in
   topological order (each via this same flow).
3. **Server:** `POST /api/v1/blocks/install?upgrade=true` with the envelope (spec-04) —
   see §4. Dry-run first; destructive manifest changes require `--force` (mirroring the
   server's gate) and re-render the server's preview before the final confirm.
4. **Code:** `update available`/`added upstream` files written; `modified by you` files
   written **adjacent as `<file>.new`** with a summary ("3 files need manual merge:
   review blocks/crm/handlers.ts.new"); `removed upstream` listed with "delete if you
   don't use it"; barrel re-wired if entries changed. `.new` files are gitignored?
   **No** — they should be loud in `git status`; the summary says to delete them after
   merging.
5. `recordInstalled` updates version/digest/source; ledger snapshot replaced by the
   server (§4). Exit summary mirrors `add`'s.

### 4. Installer upgrade mode (core)

`POST /api/v1/blocks/install?upgrade=true` (same envelope, RBAC `manage`): target block
must already be installed with a **lower** semver version (else 409 `NOT_AN_UPGRADE`;
equal version + equal digest ⇒ 200 no-op; equal version + different digest ⇒ 409, the
force-reinstall path already exists for that). Behavior:

- Compute the manifest delta old→new. **Additive** changes apply through the existing
  idempotent steps (they already skip-and-report existing items — most of upgrade is
  free). **Modifying** changes route through the validated pipeline (`modifyField`,
  etc. — previews, backfill demands, and CHECK tightening all fire as usual).
  **Destructive** changes (object/field/relationship removed in `B`) are **reported and
  skipped by default**; applied only with `?force=true` (and then via the same
  preview-first machinery; `dropData` semantics per existing uninstall rules).
- Provenance stamping (`managedBy: block:<name>`) — unchanged items keep it; items the
  old version created but the new manifest no longer declares, when kept (no force),
  are **released to `user`** management (they're now the user's, like vendored code)
  and reported as such.
- Ledger: `version`, `manifest` snapshot, digest/source columns replaced;
  `created_objects` merged (prior ownership preserved — the Phase-14 force-reinstall
  lesson); subscriptions/webhooks re-synced to the new manifest (remove-by-provenance
  for dropped ones — they are runtime wiring, not user data, so removal is safe and
  not gated).
- Report shape: the install report + `upgraded: {from, to}`, `released: [...]`,
  `skippedDestructive: [...]`.
- `?dryRun=true` returns the full preview without touching anything (the CLI's step 3).

MCP: `install_block` tool gains the `upgrade` flag; OpenAPI updated; admin Blocks page
gets an "update available" hint only if trivially cheap (registry check is client-side;
skip otherwise — note as follow-up).

## Implementation notes (files)

- Core: `packages/core/src/blocks/block-installer.ts` (upgrade path — the meat),
  `block-engine.ts` (delta computation helper `diffManifests(old, new)` lives in core
  so CLI and server share it — export it), `block-routes.ts` (?upgrade), `block-store.ts`
  (snapshot replace semantics).
- CLI: `packages/cli/src/commands/{diff,update}.ts` (new), reusing spec-03 resolver +
  spec-04 verify + `diffManifests` from core; unified-diff rendering via a tiny vendored
  LCS or the `diff` npm package (CLI dep — fine).
- Docs: `docs/concepts/building-blocks.md` "Updating blocks" section (the ownership
  contract, `.new` convention, force semantics); block README template mentions it.

## Acceptance criteria

1. Fixture: crm 0.2.0 installed + user edits one vendored file + registry has 0.3.0
   (adds a field, modifies a constraint, removes a task, changes two code files — one
   the user touched). `diff` reports every category correctly; `update` applies the
   field + constraint through previews, skips the task removal (reports it), overwrites
   the untouched file, writes `<file>.new` for the touched one, and the server ledger
   shows 0.3.0 with the new snapshot + digest.
2. Destructive change without `--force` never drops anything; with `--force` it routes
   through preview-first and applies; released items flip `managedBy` to `user` and the
   report says so.
3. `update` on an equal version is a no-op (200); downgrade attempt refused with the
   documented recovery hint; dep-range violation refused with the ordered plan;
   `--with-deps` performs the chain.
4. Upgrade is transactional per step and idempotent on re-run after an interruption
   (kill it mid-way in the test; re-run completes cleanly — the existing
   skip-and-report property must hold).
5. `git status` after an update with conflicts shows only expected paths (`.new` files
   present, user files untouched).

## Test plan

- Core unit: `diffManifests` matrix (add/remove/modify × every manifest section);
  upgrade-mode installer tests (additive/modifying/destructive/force/released/no-op/
  downgrade) against the fake stores used by existing installer tests.
- Integration: the acceptance-1 scenario end-to-end in
  `platform.integration.test.ts` (server side) + a CLI-level test with a fixture
  registry (client side).
- Live smoke (numbered, repo convention): the full crm 0.2.0 → 0.3.0-fixture loop
  against real Postgres with a scaffolded project.

## Implementation amendments (2026-07-08)

Approved deviations from the design text above, decided at implementation time:

1. **`diffManifests` lives in core but is NOT imported by the CLI.** The CLI has
   a zero-core-runtime-dependency rule (the `ref.ts` vendored-copy precedent),
   so "CLI and server share it" is realized over the wire instead: the dry-run
   upgrade response carries the computed delta as **`report.delta`** (plus
   schema previews as `report.previews`), and the CLI renders that. The differ
   itself is `packages/core/src/blocks/manifest-diff.ts` (exported from core
   for programmatic users).
2. **No MCP `install_block` tool exists**, so there is no `upgrade` flag to add.
   Instead: OpenAPI's `/api/v1/blocks/install` documents the new
   `upgrade`/`dropData` query params and the 409 response, and the MCP
   `list_blocks` tool description points agents at `ion-drive update <name>`.
   The admin "update available" hint was assessed as not trivially cheap
   (client-side registry check) — recorded as a roadmap follow-up.
3. **Tasks are destructive (gated); subscriptions/webhooks are runtime wiring.**
   A task removed by the new version is skipped by default and only removed
   under `force`; a *changed* task updates in place, preserving the live
   `enabled` flag. Subscriptions (keyed by consumer) and outbound webhooks
   (keyed by name) re-sync ungated: dropped ones unsubscribe / are removed by
   provenance, changed webhooks update in place with the signing secret
   preserved.
4. **`?dropData` was added to `/install`** (meaningful with `upgrade`+`force`):
   removed objects that still hold rows trip the same data guard as uninstall
   (409) unless `dropData` is set.
5. **Backfill rule for `isRequired` tightening:** the field's own manifest
   `defaultValue` doubles as the backfill for existing NULL rows; when absent,
   that step fails actionably (REQUIRES_BACKFILL naming the field) and the
   upgrade is safely re-runnable after fixing the manifest or the data.
6. **Failure semantics are begin-with-old/finish-with-new (AC4):** an upgrade
   only flips the ledger status to `installing`; the prior version + manifest
   snapshot stay in the row until the installer succeeds
   (`BlockStore.setStatus`/`replaceInstalled`). A mid-way failure marks the
   row `failed` with the OLD snapshot intact, so fixing the cause and
   re-running the SAME upgrade recomputes the same delta and the idempotent
   steps complete it. A `failed` row never answers an equal-version request
   as a no-op (409 pointing at force reinstall), and the CLI's local
   up-to-date short-circuit does not fire for failed rows.

## Status

**Implemented 2026-07-08, commit a6764d9** (core installer upgrade mode + engine gates +
`ion-drive diff`/`update`). Verified by: core unit suites
(`manifest-diff.test.ts`, `block-installer-upgrade.test.ts`,
`block-engine-upgrade.test.ts`), the server-side integration suite
(`blocks-upgrade.integration.test.ts`, incl. the AC4 failure-injection +
re-run scenario and the spec-06 junction rider), the CLI fixture-registry
suite (`update.integration.test.ts`, AC1/AC3/AC5), and a numbered live smoke
against real Postgres.
