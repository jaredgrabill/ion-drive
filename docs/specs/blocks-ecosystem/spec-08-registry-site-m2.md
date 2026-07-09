# Spec 08 — Registry Data Surfaces, Search, Directory, and Registry MCP (M2)

> **Status:** ✅ implemented 2026-07-09 (fresh-agent verifier sign-off; commit hash
> stamped by the orchestrator in the sign-off commit).
> **Amendments adopted during implementation:**
> - `index.json` also gains optional **`registriesUrl`** (spec-01 amended) — the Pages
>   layout serves `registries.json` at the repo root, so sibling resolution alone
>   can't discover it; `registry build` sets it when the root file validates, clients
>   fall back to the sibling path.
> - Search index shape: plain documents in a `{ schemaVersion: 1, generatedAt,
>   documents: [{ name, title, description, categories, latest, trust }] }` envelope,
>   sorted by name — no minisearch dependency. A core Zod/JSON Schema for this file
>   was deliberately deferred.
> - `registry build` status edits (`yank`/`deprecate`) sync `latest` into the
>   search index and badge so `--check` stays a no-op; `BuildResult` gained
>   `deleted[]` (stale readme copies are removed and reported as drift).
> - Badge official-green is `#006300` (7.54:1 white-text contrast, dataviz-validated;
>   the lighter status green failed at 3.35:1). Blocks repo `.gitattributes` also
>   pins `*/README.md -text` (readme copies are byte-compared against sources).
> - `registry add` gained `-y/--yes`; `preview_install` degrades to empty server
>   state + a warning when the server is unreachable (documented divergence from
>   `add`, which fails hard — parity is asserted with identical injected state).
> - AC5's screenshot half: Chrome tooling was unavailable to the agents; badge
>   rendering is evidenced by snapshot tests, XML well-formedness, computed
>   contrast, and HTTP-served embeds. The live-URL embed check is in OWNER-TODO
>   (F23-gated).

> **Rewritten 2026-07-09 per the ADR-023 amendment:** the statically generated site at
> `registry.iondrive.dev` is **dropped** — that host serves JSON and artifacts only,
> forever. The human browsing surface is the client-rendered blocks browser on
> `iondrive.dev` (spec-10). What remains here is everything that *feeds* browsers,
> search, and agents: registry-data emissions from `ion-drive registry build`, the
> `ion-drive search` command, directory-based registry discovery, and the registry MCP
> tools.

**Lands in:** `jaredgrabill/ion-drive` (`packages/cli` + small core schema amendment)
and `jaredgrabill/ion-drive-blocks` (regenerated registry output, PR template).
**Depends on:** spec-01 (protocol), spec-05 (`registry build`). The *live-serving*
half is owner-gated on F23; everything here is buildable and testable against the
local registry tree.

## Scope

Turn "a directory of JSON files" into "an ecosystem you can browse and query" without
ever adding a server or a site build to the registry host: `registry build` emits the
search index, badges, and per-block READMEs as more static files; `ion-drive search`
and the spec-10 browser consume them; the PR-reviewed third-party registries directory
gets its submission workflow and `ion-drive registry add @ns` discovery; and MCP tools
give agents first-class registry access — LLM-first DX is a product goal, and registry
data being static JSON makes this cheap.

## Non-goals

- Any web UI (spec-10 owns the browser at `iondrive.dev`).
- Anything requiring a server: accounts, publishing UI, download counts, ratings
  (M3 is withdrawn — see ADR-023 amendment; GitHub stars/issues cover ratings).
- Rebuilding the admin console's Blocks page (separate surface; it may link out).

## Design

### 1. Registry-data emissions from `ion-drive registry build`

Three new outputs, regenerated alongside the registry JSON (same append-only/`--check`
discipline; all are **mutable** display data, not release artifacts — they never
invalidate immutability guarantees):

- **`registry/search-index.json`** — a plain documents array (or
  minisearch-serialized if it stays small; keep the file < a few hundred KB): fields
  `name, title, description, categories, latest, trust`. Advertised via a new
  **optional `searchUrl`** field on `index.json` (spec-01 schema amendment:
  backward-compatible optional field on `registryIndexSchema` + regenerated JSON
  Schema, not a version bump).
- **`registry/blocks/<name>.readme.md`** — a copy of the block dir's `README.md`
  (when present), advertised via a new **optional `readmeUrl`** field on the per-block
  doc (same amendment treatment). This keeps the browser same-origin and the protocol
  self-contained — no raw-GitHub coupling.
- **`badges/<name>.svg`** — shields-style static trust/version badges for third-party
  READMEs, rendered from the index entry (display-hint trust only, per spec-01 §3).

`--check` covers all three (drift fails CI). The blocks repo regenerates once and
commits.

### 2. Search

Consumers of the index:

- The `iondrive.dev` blocks browser (spec-10, client-side).
- **`ion-drive search <term>`** (new CLI command): fetches the registry's
  `searchUrl` index when advertised, else falls back to substring match over
  `index.json` entries (works for every third-party registry with zero extra
  requirements). `--registry @ns`, `--json`. Output rows include the badge hint and an
  `ion-drive add` hint.

### 3. Registries directory + discovery

- Submission: PR adding an entry to `registries.json` (shape in spec-01 §6) using a
  new PR template + the review checklist from the operations runbook (spec-05): public
  HTTPS v1 index that parses, namespace not colliding/squatting, working owner
  contact, description accurate. Review is a *listing* review, said explicitly.
- **`ion-drive registry add @acme`** (no URL — the discovery form reserved in
  spec-03): fetch the main registry's `registries.json`, find the namespace, show
  `owner/url/description`, confirm, write config. Unknown ⇒ "not in the directory —
  pass the URL explicitly" (which still works and is the private-registry path).

### 4. Registry MCP tools

Give agents first-class registry access. One implementation, transport-free handlers
(`(args) → JSON`, no stdio assumptions):

- **CLI-embedded MCP server**: `ion-drive mcp` (stdio) exposing `search_blocks(term)`,
  `get_block(name)` (per-block JSON + README when advertised), `list_registries()`,
  and `preview_install(ref)` (runs the spec-03 resolver + spec-04 verification dry —
  returns plan + trust verdicts, no changes). This composes with the *platform's*
  per-server MCP surface at `/api/v1/mcp`: a coding agent uses the CLI MCP to choose
  blocks, then the server MCP/REST to work with installed data.

Scaffolded projects' `AGENTS.md`/skills (from `ion-drive init`) gain a paragraph
teaching agents these tools exist (`ion-add-block` skill update).

## Implementation notes (files)

- `packages/cli/src/registry/build.ts` — the three emissions + `--check` coverage;
  badge SVG rendering is a small pure template (follow the repo's dataviz conventions
  for the palette).
- `packages/core/src/blocks/registry-types.ts` — optional `searchUrl` (index) +
  `readmeUrl` (block doc); `emit:schemas` regenerated; the CLI's lenient
  `registry/protocol.ts` reader picks both up.
- `packages/cli/src/commands/search.ts` — new; `commands/registry.ts` — the no-URL
  `add @ns` form; `packages/cli/src/mcp/` — the MCP server
  (`@modelcontextprotocol/sdk` becomes a CLI dep), `commands/mcp.ts`.
- `ion-drive-blocks`: regenerated `registry/` output (+ badges, readmes,
  search-index), `.github/PULL_REQUEST_TEMPLATE/registry-listing.md`, runbook
  checklist section.
- Docs: `docs/concepts/building-blocks.md` discovery section; CLI README.

## Acceptance criteria

1. `registry build` on the blocks repo emits search-index, badges, and readme copies;
   `--check` is a no-op on the regenerated tree and fails on hand-tampered emissions;
   all emitted JSON still passes core's strict parsers (`searchUrl`/`readmeUrl`
   round-trip; older indexes without them stay valid).
2. `ion-drive search invoi` finds `invoicing` via the index on a fixture registry with
   `searchUrl`, and via substring fallback on one without it.
3. `ion-drive registry add @acme` resolves through a directory fixture, confirms, and
   writes config; unknown namespace produces the documented hint.
4. MCP: from a stock MCP client, `search_blocks` → `get_block` → `preview_install`
   round-trips against a local fixture registry; `preview_install` reports the same
   plan and trust verdicts as `ion-drive add --dry-run` (shared code path, asserted by
   test).
5. Badge SVGs render valid SVG and embed correctly in a third-party README (manual
   check, screenshot in the run report).

## Test plan

- Build unit tests (in-memory fs): emission shapes, `--check` matrix additions,
  search-index build, badge snapshot.
- Core unit: `searchUrl`/`readmeUrl` schema round-trip + JSON Schema drift regen.
- CLI unit: search fallback matrix, directory-based `registry add`, MCP handlers
  (transport-free, straight function calls).
- Live: the MCP round-trip against a locally served registry recorded as a numbered
  smoke.
