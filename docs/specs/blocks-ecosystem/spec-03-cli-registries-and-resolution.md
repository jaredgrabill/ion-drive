# Spec 03 — CLI: Multi-Registry Config, Namespaced Refs, Resolver

> **Status:** ✅ implemented 2026-07-08, commit 5144341

**Lands in:** `jaredgrabill/ion-drive` (`packages/cli`).
**Depends on:** spec-01 (protocol), spec-02 (ranges, `splitBlockRef`). Can run in
parallel with spec-04; the two meet in `add.ts` (04 inserts digest verification into the
fetch path this spec builds — coordinate the `fetchArtifact` seam described below).

## Scope

Everything between "the user types a ref" and "the CLI holds verified-ready manifest
bytes + a plan": the `registries` config map with `${ENV}` expansion and private-registry
auth, the `@ns/name[@version|@range]` ref grammar, resolver (range collection +
highest-satisfying selection + conflict reporting), per-registry disk caching, the
enriched `blocks[]` install record, and the `ion-drive registry add/list/remove`
commands.

## Non-goals

- Digest/attestation verification and trust badges (spec-04 — but this spec creates the
  seams it hooks).
- `registry build` / publishing (spec-05). `search` (spec-08).
- Server-side anything.

## Design

### 1. `ion.config.json` (revised) (`packages/cli/src/config.ts`)

```json
{
  "serverUrl": "http://localhost:3000",
  "apiKey": "iond_…",
  "registries": {
    "@ion": "https://registry.iondrive.dev/registry/index.json",
    "@acme": {
      "url": "https://blocks.acme.internal/registry/index.json",
      "headers": { "Authorization": "Bearer ${ACME_REGISTRY_TOKEN}" }
    }
  },
  "defaultRegistry": "@ion",
  "blocks": [
    {
      "name": "crm",
      "version": "0.2.0",
      "digest": "sha256:ab12…",
      "source": "@ion",
      "sourceUrl": "https://registry.iondrive.dev/…/crm/dist/0.2.0/block.json",
      "installedAt": "2026-07-08T00:00:00Z"
    }
  ]
}
```

- A registry entry is a URL string or `{ url, headers?, params? }` (the shadcn 3.0
  shape). `headers`/`params` values support `${VAR}` placeholders expanded from
  `process.env` at fetch time; an unset variable is a hard, named error before any
  network call. `params` are appended to every request to that registry (private-registry
  query-token pattern).
- `@ion` is **built in** (present even when `registries` is absent) and overridable by
  declaring it. `defaultRegistry` defaults to `"@ion"`; bare refs resolve there.
- `ION_DRIVE_REGISTRY` env var keeps working: it overrides the *default registry's URL*
  for the invocation (unchanged escape hatch for CI/dev).
- The legacy `registryUrl` field is **dropped**: when present, warn once
  ("`registryUrl` is no longer read — declare it under `registries` and set
  `defaultRegistry`") and ignore it. `recordInstalled` writes the enriched record above
  (digest/source filled by spec-04's verification result; this spec passes them
  through); `recordRemoved` (used by `ion-drive remove`) must delete the record —
  today's behavior, re-asserted in tests because the record now carries integrity data
  that `audit` (spec-06) trusts.
- **Secret hygiene:** on config load, any literal-looking secret in `headers`/`params`
  (value matches `/[A-Za-z0-9_-]{20,}/` and contains no `${`) produces a warning
  ("use `${ENV_VAR}` — this file gets committed").

### 2. Ref grammar (CLI arguments)

```
ref        := [namespace "/"] name [ "@" selector ]
namespace  := "@" [a-z][a-z0-9-]*
name       := [a-z][a-z0-9_-]*
selector   := exact semver ("0.2.0") | semver range ("^0.2.0", "1.x", ">=1 <2")
```

Examples: `crm`, `crm@0.2.0`, `crm@^0.2`, `@acme/billing`, `@acme/billing@1.x`, plus the
unchanged non-registry forms — any `https://…/block.json` URL and any local path.
Parsing reuses `splitBlockRef` from core (spec-02) for the namespace/name part; the
`@selector` split keeps today's `indexOf('@', 1)` trick (search from index 1 so the
namespace `@` never matches; for `@ns/name@sel` split on the last `@` after the `/`).
No selector ⇒ the registry's `latest` (subject to status rules below).

### 3. Registry client (rewritten) (`packages/cli/src/registry/registry-client.ts`)

Rewritten around spec-01:

- `resolveRegistry(nsOrDefault, config)` → `{ namespace, url, headers, params }`.
- `fetchIndex(registry)` → parsed + validated `index.json` (core's
  `parseRegistryIndex`).
- `fetchBlock(registry, name)` → parsed `blocks/<name>.json` (follows `blockUrl`
  relative to the index URL per spec-01 §2).
- `fetchArtifact(url, headers)` → **raw bytes** (`Uint8Array`) + the URL it came from.
  Returning bytes, not parsed JSON, is deliberate: spec-04 hashes these exact bytes
  before anything parses them. `getManifest` becomes
  `fetchArtifact → (spec-04 verify hook) → JSON.parse → asManifest`.
- Local-path and direct-URL refs behave as today (no expected digest — spec-04 records
  computed digests with `source: "local"` / the URL).
- **Cache:** `~/.ion-drive/registry-cache/<sha256(registryUrl)>.json` per registry,
  holding `{ fetchedAt, index, blocks: { <name>: {fetchedAt, doc} } }`, 5-min TTL,
  best-effort writes. Auth headers are never written to disk. Artifacts are not cached
  (verified-then-used in-process; they're small). `--no-cache` on `add`/`list`/`info`
  bypasses reads. `http:` URLs rejected unless host is `localhost`/`127.0.0.1`
  (spec-01 §1).

### 4. Resolver (`packages/cli/src/registry/resolver.ts`)

Input: the root ref (+ CLI-selector), config, and the server's installed list
(`name → version`, now available from `GET /api/v1/blocks`). Output: an ordered install
plan or a structured error. Algorithm:

1. **Closure walk** (BFS from the root): for each block, fetch its registry
   `blocks/<name>.json`, pick a *candidate* version (below), read that version's
   `dependencies` map from the registry file (no artifact fetches during planning —
   spec-01 mirrors deps for exactly this), and enqueue each dep with its range.
   - **Same-registry rule:** a bare dep name resolves in the registry the *depending
     block* was resolved from — never the consumer's default. Absent there ⇒ error
     naming the block, the registry, and the fix ("add it explicitly:
     `ion-drive add @other/thing` first, or ask the block author to publish the dep").
     `@ns/…` deps require `@ns` in the consumer's config ⇒ error "add `@ns` to
     registries" otherwise. **No silent cross-registry fallback, ever** (the
     anti-dependency-confusion rule).
   - Cross-registry name collision: two different registries supplying the same bare
     `name` in one plan ⇒ hard error (singleton rule) telling the user to pick one.
2. **Range collection:** accumulate `name → [{range, requiredBy}]` across the closure
   (the CLI selector is one more entry, `requiredBy: "you"`).
3. **Selection:** for each name, candidates = versions with `status: "active"`
   (`deprecated` allowed with a warning; `yanked` excluded — except: exact selector
   matching a version already in `ion.config.json.blocks[]`, re-install path, warn
   loudly). Pick the **highest version satisfying every collected range** by testing
   each candidate against each range (`semver.satisfies`; no range-intersection algebra).
   None ⇒ error listing every constraint with its `requiredBy`.
4. **Installed pruning/conflicts:** if installed `name`'s version satisfies all ranges ⇒
   prune from the plan (today's behavior). Installed but violating some range ⇒ error
   "crm 0.1.0 is installed but invoicing needs ^0.2.0 — run `ion-drive update crm`"
   (`--force` proceeds, mirroring the server's force contract).
5. **Order:** Kahn topological sort (kept), cycle detection (kept — cycles are now
   possible across registries too, same error).
6. **Suggestions:** unknown name in a registry ⇒ Levenshtein ≤2 against its index keys →
   "unknown block `crn`. Did you mean `crm`?".

`requires.core` from registry version entries is checked against the server's
`/health` version during planning → warning only (the server enforces, spec-02).

### 5. `ion-drive registry` command group (`packages/cli/src/commands/registry.ts`)

```
ion-drive registry list                 # table: ns, name, url, blocks count, staleness
ion-drive registry add <@ns> <url>     # validates: fetches + parses the index, then writes config
ion-drive registry add <@ns>           # M2 (spec-08): look up <@ns> in the main registry's directory
ion-drive registry remove <@ns>        # refuses while a blocks[] record has source <@ns> (--force overrides)
ion-drive registry ping [@ns]          # fetch + validate, report generatedAt/latency (debugging)
```

`registry add` with a URL that serves a legacy (unversioned) index surfaces spec-01's "pre-release format"
error. All subcommands take `--json`. (`registry build` joins this group in spec-05 —
reserve the name.) Space-themed output per `ui.ts` conventions.

### 6. `add` / `list` integration

- `add` gains: multi-registry plan rendering (each plan line shows
  `name@version · @ns` + status warnings), `--no-cache`, and passes
  digest/source through to `recordInstalled` (values produced by spec-04's hook; until
  spec-04 lands, record `digest: null`, `source`, `sourceUrl` — the field shapes ship
  here so the config format changes once).
- `list` shows the default registry's index plus `--registry @ns` to list another; and
  `--all` to walk every configured registry.

## Implementation notes (files)

- `packages/cli/src/config.ts` — revised shape, env expansion, secret warning, migration
  warning; keep `readConfig/writeConfig` API.
- `packages/cli/src/registry/registry-client.ts` — rewrite per §3 (keep `RegistryError`,
  `isUrl`, `isLocalPath`, `readLocalBlock`, `readCodeDir` largely as-is; note the stale
  doc-comment mentioning `jaredgrabill/block-registry` — fix it).
- `packages/cli/src/registry/resolver.ts` — rewrite per §4; keep the pure-function style
  and unit-testability (inject fetchers).
- `packages/cli/src/commands/{add,list}.ts` — integration; `commands/registry.ts` — new;
  register in `src/index.ts`.
- Reuse `semver` (spec-02) and `splitBlockRef` from core. The CLI resolves core the same
  way `block validate` does (project-first dynamic import) — but since these helpers are
  needed unconditionally, vendor tiny pure re-implementations in
  `packages/cli/src/registry/ref.ts` if the import dance proves fragile (decide in
  implementation; keep one source of truth if at all possible).
- Update `docs/concepts/building-blocks.md` (registries section), the scaffolded project
  README/`AGENTS.md` mentions of `registryUrl`, and `packages/cli/README.md`.

## Acceptance criteria

1. A project with no `registries` key installs `crm` from the built-in `@ion` default;
   `ION_DRIVE_REGISTRY` still overrides it.
2. `ion-drive add @acme/billing@^1.2` against a fixture registry with auth headers
   resolves `${ACME_REGISTRY_TOKEN}`, fails fast (named var) when unset, and never
   writes the token to the cache file.
3. A dep closure spanning `@acme → bare dep` resolves in `@acme` only; the same dep name
   also existing in `@ion` does not get picked (test proves the confusion vector is
   closed); missing in `@acme` produces the documented error.
4. Range conflict output lists every constraint with `requiredBy`; installed-version
   conflict names the `update` fix; `--force` proceeds.
5. Yanked versions are never auto-selected; exact re-install of a recorded version works
   with a warning; deprecated warns and proceeds.
6. `registry add/list/remove/ping` behave per §5 including the remove-guard and legacy-index
   rejection; all support `--json`.
7. `ion-drive remove <block>` deletes the `blocks[]` record.
8. Windows paths: local-path refs with backslashes keep working (existing behavior,
   re-asserted).

## Test plan

- Unit: config expansion/warnings; ref-grammar table; resolver matrices (same-registry
  rule, collision, ranges, yanked/deprecated, pruning, conflicts, cycles, suggestions) —
  all with injected fake fetchers, no network; cache read/write/TTL/no-auth-persisted.
- CLI-level: extend `packages/cli` vitest suites with a fixture registry served from
  memory (undici MockAgent or a throwaway `node:http` server on localhost — allowed
  as `http://localhost`).
- Manual smoke (recorded in the PR): two local registries + a real server, cross-registry
  install end-to-end.
