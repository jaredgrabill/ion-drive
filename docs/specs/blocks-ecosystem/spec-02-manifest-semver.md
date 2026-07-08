# Spec 02 — Manifest v1: Semver Versions, Dependency Ranges, `requires.core`

> **Status:** ✅ implemented 2026-07-08, commits ea24785 (ion-drive) + d33c979 (ion-drive-blocks)

**Lands in:** `jaredgrabill/ion-drive` (`packages/core`, plus CLI touch-ups) and
`jaredgrabill/ion-drive-blocks` (migrate the official manifests).
**Depends on:** nothing (co-first with spec-01).
**Breaking:** yes, deliberately — nothing is published (F23 open), so this is the one
moment a clean break is free. No compatibility shims.

## Scope

Upgrade the block manifest from "version is a free-form string, dependencies are bare
names" to real semver semantics: validated `version`, `dependencies` as a name→range map,
a `requires.core` range checked at install, and the server-side enforcement that goes
with it. Migrate the five official manifests.

## Non-goals

- Range *resolution* across a registry (spec-03 — this spec only defines and validates
  the fields).
- Digests/provenance (spec-04).
- npm-style multi-version installs — blocks are singletons per server; ranges are
  compatibility **constraints**, never a solver problem.

## Design

### 1. Manifest field changes (`packages/core/src/blocks/block-types.ts`)

Current → new:

| Field | Today | v1 |
|---|---|---|
| `version` | `z.string().min(1).max(32)`, default `'0.1.0'` | Strict semver `x.y.z[-prerelease]` (no build metadata; no `v` prefix). Validated with `semver.valid(v, { loose: false })` via `.refine`. Default stays `'0.1.0'`. |
| `dependencies` | `z.array(z.string())` of bare names | `z.record(blockRefSchema, rangeSchema)`, default `{}`. Key = block ref; value = semver range. |
| `requires` | `{ handlers: string[], plugins: string[] }` | gains `core?: string` (semver range, validated with `semver.validRange`). |

Supporting schemas (new, exported):

```ts
/** `crm` or `@acme/billing` — a block reference. Bare names resolve in the registry the
 *  depending block came from (spec-03); `@ns/…` names a configured registry. */
const blockRefSchema = z.string().regex(/^(@[a-z][a-z0-9-]*\/)?[a-z][a-z0-9_-]*$/);

/** Any range `semver.validRange` accepts: `^0.2.0`, `>=1.2 <2`, `1.x`, `*`. */
const rangeSchema = z.string().refine((r) => semver.validRange(r) !== null, {
  message: 'must be a valid semver range',
});
```

The bare-name part of `blockRefSchema` stays identical to today's `name` regex
(`^[a-z][a-z0-9_-]*$`) — the manifest's own `name` field is unchanged and must remain
namespace-free (namespaces are sources, not identities; the ledger and `/blocks/<name>`
paths key on bare names).

`"*"` is the escape hatch equivalent to today's unconstrained deps; the official
manifests use real ranges.

### 2. `parseManifest` cross-field checks (`block-manifest.ts`)

- Self-dependency check now inspects `Object.keys(dependencies)` and must also catch
  `@anyns/<own-name>`? **No** — `@ns/<own-name>` is a different source for the same
  name, which the singleton rule makes a conflict at install time anyway; keep the check
  on bare-name equality plus the suffix match (`ref === name || ref.endsWith('/' + name)`)
  and reject both, with the message explaining the singleton rule.
- New check: a dependency ref appearing twice with different namespace forms
  (`crm` and `@ion/crm`) is rejected (ambiguous source).
- Everything else (duplicate objects/fields/actions/hooks/code paths, seed keys)
  unchanged.

### 3. Server-side enforcement (installer preflight)

`BlockInstaller.checkRequirements` (in `packages/core/src/blocks/block-installer.ts`)
currently validates declared actions/hooks/`requires.handlers`/`requires.plugins` first,
hard-erroring on real installs and warning on dry runs. Two additions in the same step:

1. **`requires.core`**: compare against the running core version (import from
   `packages/core/package.json` — core already exports `./package.json`). Not satisfied ⇒
   `BlockEngineError` (validation, 400) naming both versions and the range; `force`
   downgrades to a warning (the ADR-017 force contract); dry run reports it as a warning
   either way.
2. **Dependency ranges**: the existing installed-dependency guard (dependency missing ⇒
   422) now also checks that each installed dependency's ledger `version` satisfies the
   declared range. Installed-but-out-of-range ⇒ same 422 family with code
   `DEPENDENCY_VERSION`, message naming the installed version, the required range, and
   the fix (`ion-drive update <dep>`); `force` overrides with a warning.

Ledger note: `_ion_blocks.version` (varchar 32) already stores the string; no schema
change here (spec-04 adds its columns separately).

### 4. Semver dependency

Add `semver` (+ `@types/semver`) to `@ion-drive/core` and `@ion-drive/cli`. This is the
boring proven choice; range parsing is exactly the code we don't hand-roll. (Zero-dep is
the *client SDK*'s constraint, not core/CLI.) Core re-exports nothing from it — it's an
implementation detail; the CLI imports it directly.

### 5. CLI touch-ups (kept minimal — spec-03 rewrites resolution properly)

- `dependenciesOf(manifest)` in `packages/cli/src/registry/registry-client.ts` returns
  `Object.keys(manifest.dependencies ?? {})` (accepting only the record form — clean
  break).
- `ion-drive block validate` picks up the new checks for free (it calls core's
  `parseManifest`); its fallback structural checks (used when core isn't resolvable)
  gain: `version` must be semver, `dependencies` must be an object.

### 6. Migration of the official blocks (`I:\ion-shift\blocks`)

In one PR: `invoicing` → `"dependencies": { "crm": "^0.2.0" }`; `catalog` →
`{ "invoicing": "^0.1.0" }`; add `"requires": { "core": ">=0.2.0 <1.0.0" }` to all five
(crm, invoicing, catalog, communications, audit); re-run `pack` so `dist/` artifacts
match; CI drift guard verifies. (The registry index migration is spec-05's; interim
breakage of the not-yet-announced raw-URL registry is acceptable per the clean-break
rule — sequence spec-05 promptly after.)

Also update the manifest JSON Schema: `block-manifest.v1.json` emitted alongside
spec-01's schemas; `ion-drive block new`'s skeleton `$schema` URL bumps to it (full
scaffold regeneration is spec-06).

### 7. Docs

- `docs/concepts/building-blocks.md`: manifest reference table — `version`,
  `dependencies`, `requires.core` sections rewritten with the range semantics and the
  singleton/constraint model spelled out.
- `I:\ion-shift\blocks\docs\platform.md` manifest table: same edit.
- MCP/OpenAPI: install/preview error shapes unchanged (same envelope), but the
  block-routes OpenAPI description for `install` should mention `DEPENDENCY_VERSION`.

## Implementation notes (files)

- `packages/core/src/blocks/block-types.ts` — schema changes; export
  `blockRefSchema`-related helpers (`splitBlockRef(ref) → { namespace?, name }` lands
  here so core and CLI share it).
- `packages/core/src/blocks/block-manifest.ts` — cross-field checks.
- `packages/core/src/blocks/block-installer.ts` — preflight additions;
  `packages/core/src/blocks/block-engine.ts` — surface warnings in the preview report.
- `packages/core/package.json`, `packages/cli/package.json` — `semver`.
- `packages/cli/src/registry/registry-client.ts` — `dependenciesOf`.
- `packages/cli/src/commands/block.ts` — validate fallback checks.
- `I:\ion-shift\blocks\*/block.json` + repack — migration.

## Acceptance criteria

1. A manifest with `version: "1.0"` (not semver), `version: "v1.0.0"`, or a dependency
   range `"latest"` fails `parseManifest` with messages naming the field and expected
   format.
2. `dependencies` as an array (the legacy form) fails parse with a message pointing at the v1
   record form.
3. Installing a block whose `requires.core` excludes the running core version returns
   400 naming both; `?force=true` installs with a warning in the report; `?dryRun=true`
   reports the warning without failing.
4. Installing a block whose dependency is installed at an out-of-range version returns
   422 `DEPENDENCY_VERSION`; in-range succeeds; `force` overrides.
5. All five official manifests parse under v1, their packed artifacts are drift-clean,
   and the blocks repo CI passes.
6. `splitBlockRef` handles `crm`, `crm@…` rejection (at-suffix is not part of a ref —
   version pinning is CLI argument grammar, spec-03), `@acme/billing`, and rejects
   `@Acme/x`, `@a/b/c`, `-bad`.

## Test plan

- Core unit tests (`block-manifest.test.ts` grows): each rejection above, plus
  happy-path record deps and `requires.core` acceptance; `splitBlockRef` table test.
- Installer unit tests: preflight core-range + dependency-range matrices (satisfied /
  unsatisfied / force / dryRun).
- Integration (`platform.integration.test.ts`): one scenario — install block A 0.1.0,
  then a block B requiring `A@^0.2.0` fails 422, force succeeds; a block with impossible
  `requires.core` fails 400.
- Blocks repo CI run is the migration's verification.
