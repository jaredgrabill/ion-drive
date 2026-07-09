# Spec 08 — Registry Site, Search, Directory, and Registry MCP (M2)

> **ADR-023 (2026-07-09):** the in-repo `/site` option is **confirmed** — the site is a
> pure function of the registry JSON and must regenerate atomically with every publish.
> Domain note: the canonical schema `$id`s move to `https://iondrive.dev/schemas/*`
> (domain-unification warm-up); this site links to them and to the `iondrive.dev`
> project page (spec-10).

**Lands in:** `jaredgrabill/ion-drive-blocks` (`/site` — in-repo, deploys with the same
Pages site as the registry; confirmed by ADR-023) + small CLI additions.
**Depends on:** spec-01 (protocol), spec-05 (live registry + Pages — the *serving* half
is owner-gated on F23; the generator, search, MCP tools, and CLI additions are all
buildable and testable against the local registry tree).

## Scope

The read-side product that turns "a directory of JSON files" into "an ecosystem you can
browse": a statically generated site at `registry.iondrive.dev` (directory, per-block
pages, trust badges), a prebuilt search index consumed by both the site and a new
`ion-drive search`, the PR-reviewed third-party registries directory with
`ion-drive registry add @ns` discovery, and MCP tools so agents can discover blocks —
LLM-first DX is a product goal, and registry data being static JSON makes this cheap.

## Non-goals

- Anything requiring a server: accounts, publishing UI, download counts, ratings
  (counts arrive with M3; ratings never — GitHub stars/issues do that job).
- Rebuilding the admin console's Blocks page (separate surface; it may link here).

## Design

### 1. Static site generator

A small SSG living in `site/` (implementer's choice of tool — constraints: TypeScript,
zero-runtime output (plain HTML+CSS+minimal JS), builds from the registry JSON in the
same repo checkout, no framework lock-in that fights the "just static files" posture;
Astro or a hand-rolled generator both qualify — pick per taste, document the choice).
Build runs in the publish workflow after `registry build` and deploys with Pages.

Pages:

- **Home / directory** — block cards (title, description, categories, latest version,
  trust badge), category filter, search box (client-side, §2).
- **Block page** (`/blocks/<name>`) — rendered README (from the block dir), install
  snippet (`ion-drive add crm`), version table (version, publishedAt, digest —
  truncated with copy button, status, attestation link → Rekor/GitHub attestation UI),
  advisories, dependency graph (deps + dependents computed across the registry),
  **manifest browser**: objects/fields/relationships rendered as tables + a simple ERD
  (the manifest is rich enough; SVG generated at build time — follow the repo's
  dataviz conventions), declared actions/hooks/tasks/webhooks, `requires`.
- **Registries directory page** (`/registries`) — renders `registries.json` with the
  "listed ≠ audited" disclaimer and the submission process (PR checklist).
- **Schemas** (`/schemas/*`) — the spec-01 JSON Schemas (already served; link them).
- Trust badges as static SVGs (`/badges/<name>.svg`, generated at build) so third-party
  READMEs can embed them shields-style.

### 2. Search

At build time, emit `search-index.json` (minisearch-serialized or a plain documents
array — keep it < a few hundred KB; fields: name, title, description, categories,
latest, trust). Consumers:

- The site (client-side minisearch).
- **`ion-drive search <term>`** (new CLI command): fetches the default registry's
  `search-index.json` if present (URL advertised via an optional `searchUrl` field
  added to `index.json` — spec-01 schema gains this optional field), else falls back to
  substring match over `index.json` entries (works for every third-party registry with
  zero extra requirements). `--registry @ns`, `--json`. Output rows include the badge
  and an `ion-drive add` hint.

### 3. Registries directory + discovery

- Submission: PR adding an entry to `registries.json` (shape in spec-01 §6) using the
  PR template + review checklist from the operations runbook (spec-05): public HTTPS v1
  index that parses, namespace not colliding/squatting, working owner contact,
  description accurate. Review is a *listing* review, said explicitly.
- **`ion-drive registry add @acme`** (no URL — the discovery form reserved in spec-03):
  fetch the main registry's `registries.json`, find the namespace, show
  `owner/url/description`, confirm, write config. Unknown ⇒ "not in the directory —
  pass the URL explicitly" (which still works and is the private-registry path).

### 4. Registry MCP tools

Give agents first-class registry access. Two deliveries, one implementation:

- **CLI-embedded MCP server**: `ion-drive mcp` (stdio) exposing `search_blocks(term)`,
  `get_block(name)` (per-block JSON + README), `list_registries()`, and
  `preview_install(ref)` (runs the spec-03 resolver + spec-04 verification dry —
  returns plan + trust verdicts, no changes). This composes with the *platform's*
  existing MCP surface (which is per-server, at `/api/v1/mcp`): a coding agent uses the
  CLI MCP to choose blocks, then the server MCP/REST to work with installed data.
- The same tool handlers behind a thin adapter so the M3 service can host them
  remotely later (design the handlers transport-free: `(args) → JSON`, no stdio
  assumptions).

Scaffolded projects' `AGENTS.md`/skills (from `ion-drive init`) gain a paragraph
teaching agents these tools exist (`ion-add-block` skill update).

## Implementation notes (files)

- `ion-drive-blocks/site/**` — generator + templates; `publish-block.yml` gains the
  build+deploy step (spec-05's workflow, amended here).
- Spec-01 schema amendment: optional `searchUrl` on `index.json` (add to
  `registry-types.ts` + JSON Schema; backward-compatible optional field, not a version
  bump).
- `packages/cli/src/commands/search.ts` — new; `commands/registry.ts` — the no-URL
  `add @ns` form; `packages/cli/src/mcp/` — the MCP server (`@modelcontextprotocol/sdk`
  is already a core dep; CLI adds it), `commands/mcp.ts`.
- `ion-drive-blocks/.github/PULL_REQUEST_TEMPLATE/registry-listing.md` + runbook
  checklist section.
- Docs: `docs/concepts/building-blocks.md` discovery section; CLI README; site README.

## Acceptance criteria

1. The deployed site renders every official block's page with version table, digests,
   attestation links, manifest browser + ERD, and correct badges; a broken README or
   missing field degrades gracefully (build warns, page renders without the section).
2. Site build is deterministic from the repo checkout and runs green inside the publish
   workflow (no network beyond the checkout).
3. `ion-drive search invoi` finds `invoicing` via the index on `@ion` and via substring
   fallback on a fixture registry without `searchUrl`.
4. `ion-drive registry add @acme` resolves through the directory fixture, confirms, and
   writes config; unknown namespace produces the documented hint.
5. MCP: from a stock MCP client, `search_blocks` → `get_block` → `preview_install`
   round-trips against the live registry; `preview_install` reports the same plan and
   trust verdicts as `ion-drive add --dry-run` (shared code path, asserted by test).
6. Badge SVGs embed correctly in a third-party README (manual check, screenshot in PR).

## Test plan

- Generator unit tests (fixture registry → HTML snapshots for one block page; ERD SVG
  snapshot); search-index build test.
- CLI unit tests: search fallback matrix, directory-based `registry add`, MCP handlers
  (transport-free, straight function calls).
- Live: deploy-preview of the site from a PR (Pages preview or artifact), linked in the
  PR; the MCP round-trip recorded as a numbered smoke.
