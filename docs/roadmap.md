# Ion Drive — Post-Phase-10 Review: Findings & Roadmap

**Date:** 2026-07-06 · **Reviewed against:** [implementation_plan.md](implementation_plan.md),
the ADRs in [research/architecture-decisions.md](research/architecture-decisions.md), and the
product positioning in `CLAUDE.md` (ADR-017: application backend platform, "self-hosted
Firebase meets an infinitely configurable ERP", built for agentic-LLM development).

This document is the canonical backlog. It catalogs every gap, punt, and deliberately-deferred
item found in a full review of the codebase after Phase 10 shipped, and organizes them into
proposed future phases. When a phase ships, move its note into `implementation_plan.md` /
`CLAUDE.md` as usual and prune it here.

Legend: 🔴 broken/misleading today · 🟠 gap vs. our own stated conventions · 🟡 planned-but-missing capability · ⚪ polish · ✅ resolved.

> [!NOTE]
> **Same-day sweep (2026-07-06):** immediately after this review, the low-hanging findings were
> fixed — F1, F3, F4, F5, F7, F13, the F2 script breakage, the MCP half of F6, the admin logs
> export, and the contributor skills from §3.1. Rows below are marked ✅ with what remains.

---

## Part 1 — Findings

### 1.1 Broken or misleading as shipped 🔴

| # | Finding | Detail |
|:--|:--|:--|
| F1 | ✅ **No CI pipeline** | Fixed 2026-07-06: `.github/workflows/ci.yml` (lint/typecheck/test/build + a Postgres-17 integration job), PR/issue templates, `SECURITY.md`. Still missing: `CODE_OF_CONDUCT.md`. |
| F2 | ✅ **`pnpm test:integration` was broken** | Script fixed 2026-07-06 (`vitest.integration.config.ts` created). Suite seeded 2026-07-06: `packages/core/src/integration/platform.integration.test.ts` (scratch-DB-per-run, real `createServer()` over `.inject()`; auth bootstrap, schema/CRUD/constraints, expand, GraphQL, outbox events, block lifecycle, RBAC — `passWithNoTests` removed). Further scenarios (tasks, MCP, snapshot/doctor, secrets) still welcome. |
| F3 | ✅ **Observability overlay overpromised** | Fixed 2026-07-06: Prometheus scrape config (`/metrics` via host-gateway), Grafana datasources + Ion Drive Overview dashboard provisioning, Loki/Tempo single-binary configs, mounts wired, broken image tags corrected. Validated (`compose config`, YAML/JSON parse) but not yet live-tested against a running stack. |
| F4 | ✅ **Docs drift: block catalog** | Fixed 2026-07-06 in `docs/getting-started.md` and both README spots. The `new-block` skill now ends with a catalog-enumeration checklist step. |
| F5 | ✅ **No `.env.example`** | Added 2026-07-06, every var cross-checked against `config/index.ts` (including the new `ION_RATE_LIMIT_*`). |

### 1.2 Surface-parity gaps 🟠

Our own convention (`CLAUDE.md`): *a capability added to one surface should be reflected in
REST, GraphQL, MCP, and OpenAPI.* These violate it:

| # | Finding | Detail |
|:--|:--|:--|
| F6 | ✅/🟠 **`expand=` is REST-only** | MCP half fixed 2026-07-06: `query_data`/`get_record` gained `expand` (same `string[]` contract as REST). GraphQL still has **no relationship traversal** (no nested object types — relations are bare FK scalars); that remains Phase 13. |
| F7 | ✅ **No `ion.event.*` metrics** | Fixed 2026-07-06: `ion.event.published` counter, `ion.event.deliveries` counter (`ion.outcome` attr), `ion.event.delivery.duration` histogram — recorded in `OutboxBus.publish` and the dispatcher, documented in `docs/concepts/events.md`. |
| F8 | ✅ **PUT missing** | Decided 2026-07-06: PATCH-only is deliberate (a stale full-replace would silently null runtime-added fields); documented in `docs/api/rest.md`. |
| F9 | ✅/🟡 **Migration `sql_down` is write-only** | Wording fixed 2026-07-06 (`schema-manager.ts` no longer implies rollback exists). Building an actual rollback API/CLI remains open — if pursued, it needs data-loss guards like the rest of the change pipeline. |

### 1.3 Planned-but-missing platform capabilities 🟡

| # | Finding | Detail |
|:--|:--|:--|
| F10 | **Multi-tenancy is aspirational** | Positioning says "database-per-tenant by default"; the plan's verification scenarios (create tenant → isolated DB) are unmet. Today: `createTenantDb` exists but there is exactly one tenant DB from config — no tenant provisioning, routing, lifecycle, or per-tenant migrations. |
| F11 | **Actor identity** (carried from Phase 9) | No `created_by`/`updated_by` system fields; event payloads carry no `actorId`; `audit_log.changed_by` is always null; `_ion_migrations.applied_by` never populated. Requires threading `request.auth` through `DataService` writes on all three surfaces. |
| F12 | **Field-level RBAC** | `permission-engine.ts` says "field-level scoping is a future extension". Object-level only today. Row-level policies (owner-scoped reads) are also absent — relevant for the app-backend positioning. |
| F13 | ✅ **No rate limiting / brute-force protection** | Fixed 2026-07-06: `@fastify/rate-limit`, config-gated `ION_RATE_LIMIT_*` (default on: 300/min global per IP, 20/min on `/api/auth/*` via an independent keyed bucket), `/health`+`/metrics` exempt. Live-smoked against Postgres. |
| F14 | **No realtime** | No way for an app to subscribe to data changes (SSE/WebSocket). The outbox + dispatcher already produce ordered `data.<object>.<op>` events — a realtime bridge is mostly transport work. (Logs already stream over SSE, so the pattern exists in-repo.) |
| F15 | **No outbound webhooks** | Composable today only by hand (subscription + `http_request` task handler). A first-class `webhook` event handler (signed payloads, retries, delivery log) is a natural near-term win on the same infrastructure. |
| F16 | **No file/blob storage** | "Self-hosted Firebase" implies a storage story. Nothing exists — needs a `StorageProvider` port (Phase 9 pattern), a local-disk default, an S3-compatible plugin, and a `file` field type. |
| F17 | **`removeRelationship` missing** | `SchemaManager` cannot delete relationships; snapshot push warns/skips relationship removals; the admin has no delete-relationship action. |
| F18 | **Delivery DLQ has no surface** | Failed event deliveries (`maxAttempts` exhausted) sit in `_ion_event_deliveries` with no admin view, no retry button, no alerting. |
| F19 | **External plugin packages don't exist yet** | The ports (cache/email/bus) are proven with in-core defaults; `@ionshift/plugin-redis`, `plugin-sendgrid`/SMTP, `plugin-rabbitmq` are still to be built as separate repos/packages. |

### 1.4 CLI & end-user developer experience 🟡

The end-user story ("init a project, pull blocks, manage schema") has gaps once you leave the monorepo:

| # | Finding | Detail |
|:--|:--|:--|
| F20 | **`ion-drive dev` is monorepo-only** | It spawns `pnpm --filter @ionshift/ion-drive-core dev` — meaningless for a user who installed the CLI globally next to their own app. It should run the server via Docker (compose scaffold) or a published server binary/dist. |
| F21 | **`init` doesn't scaffold infrastructure** | A standalone user gets `ion/client.ts` + example, but no `docker-compose.yml`, no `.env`, no way to actually stand the server up from their project directory. |
| F22 | **No block-authoring support** | Third parties can serve manifests by URL, but there's no `ion-drive block new` (scaffold a manifest), `block validate` (run the Zod parser locally), or `block emit`. Block authoring currently requires cloning this monorepo. |
| F23 | 🟡 **Nothing is published** | Pipeline built 2026-07-06 (Phase 14 Tier 0): changesets (fixed version group core/admin/cli/client; blocks excluded per ADR-018 amendment), tag-triggered `release.yml` (npm publish w/ provenance + version/changeset/blocks-dep guards; GHCR image, amd64+arm64; `workflow_dispatch` = full dry-run), packages publishable (`files`, `publishConfig`, per-package READMEs), CLI's bundled catalog now optional (graceful fallback). Verified: `pnpm pack` → scratch-project install boots core **and serves `/admin` from the installed admin package**. Remaining: the **first real publish** (owner-run — needs `NPM_TOKEN` secret + `v0.x` tag), Docker image not yet pushed anywhere. |
| F24 | **No agent-facing project instructions** | For a platform *built for agentic development*, `init` ships no `AGENTS.md`/`CLAUDE.md` template telling the user's coding agent how to talk to their Ion Drive backend (MCP endpoint, query language, schema-change workflow, SDK idioms). See Part 3. |

### 1.5 Deferred polish backlog ⚪

Carried from Phases 8–10 (see memory/ADR notes), still valid:

- **Admin:** m2m link editing (chip lists + junction rows); ~~command-palette record search (global `q=`)~~ (✅ 2026-07-06 — debounced `q=` fan-out across the first 8 non-system objects; selecting a result opens the object grid with the search prefilled); ~~logs export button~~ (✅ 2026-07-06 — JSON/CSV export of the filtered view); column pinning; "delete → Undo" toast; popover calendar date picker; stat-card trend deltas (needs persisted stats history); ~~`vitest-axe` assertions (dep installed, unused)~~ (✅ 2026-07-06 — matcher wired in vitest.setup.ts; `src/a11y.test.tsx` runs axe over Button/form fields/Checkbox+Switch/EmptyState/Tabs/Dialog/Login, zero violations found).
- **Schema engine:** ~~doctor's `AUTH_TABLES` allowlist is hardcoded (ask the `AuthProvider` for its tables)~~ (✅ 2026-07-06 — `AuthProvider.getManagedTables?()` feeds the doctor's `systemTables` option; list lives in the Better Auth adapter); `renderDefaultExpression` treats any value ending in `)` as a SQL expression (needs an `isLiteral` escape hatch); no admin UI for snapshots (CLI-first by design — revisit).
- **Code health:** ~~27 Biome cognitive-complexity warnings~~ (✅ 2026-07-06 — cleared to zero via behavior-preserving helper extraction across 19 files, no suppressions). ~~Yoga logging adapter serialized `Error`s to `{}`~~ (✅ 2026-07-06 — `api/graphql/plugin.ts` now maps a leading Error to pino's `err` key).
- **Docs:** ~~`docs/deployment/kubernetes.md`; backup/restore guide; security hardening checklist~~ (✅ 2026-07-06); performance benchmarks (promised under Phase 7 "Polish") still outstanding. ~~Hardening gaps surfaced by the checklist (no `trustProxy`, unauthenticated `/metrics`, signup stays open after first admin)~~ (✅ 2026-07-06, Phase 14 warm-up — `ION_TRUST_PROXY`, `ION_METRICS_TOKEN` bearer auth, `ION_DISABLE_SIGNUP` closes signup once the first admin exists; checklist updated, live-smoked).

---

## Part 2 — Proposed future phases

Ordered by value-per-effort and dependency. Numbers continue from Phase 10.

### Phase 11 — Launch readiness (CI, tests, ops)
1. ~~GitHub Actions CI~~ ✅ 2026-07-06. (F1)
2. ~~Real integration test suite~~ ✅ seeded 2026-07-06 (`platform.integration.test.ts`: auth, schema, CRUD, expand, GraphQL, events, blocks, RBAC) — extend with tasks/MCP/snapshot-doctor/secrets scenarios as they earn their keep. (F2)
3. ~~Observability overlay provisioning~~ ✅ 2026-07-06 — remaining: live-test the stack once against real traffic and iterate the dashboard. (F3)
4. ~~Rate limiting~~ ✅ 2026-07-06. (F13)
5. ~~Repo hygiene~~ ✅ 2026-07-06 (`CODE_OF_CONDUCT.md` still optional). (F4, F5)
6. Release pipeline: changesets (or similar), npm publish workflow for `core`/`cli`/`client`/`blocks`, Docker image publish. (F23) → **moved to Phase 14 Tier 0** — publishing is a hard prerequisite for framework mode (ADR-018).
7. ~~Docs: `deployment/kubernetes.md`, backup/restore, security checklist~~ ✅ 2026-07-06 (cross-linked from README/getting-started/docker.md; manifests are reference-grade, not cluster-certified). (⚪)

### Phase 12 — Events to the edge (realtime, webhooks, identity)
1. Actor identity: `created_by`/`updated_by` system fields, actor threaded from `request.auth` through `DataService` on all surfaces, `actorId` in event payloads, `audit_log.changed_by` populated, `applied_by` on migrations. (F11)
2. First-class **webhooks**: `webhook` handler (HMAC-signed payloads, retry/backoff, delivery log), admin CRUD page, block-manifest support. (F15)
3. **Realtime subscriptions**: SSE endpoint (`/api/v1/events/stream?topics=data.contacts.*`) bridging the dispatcher, RBAC-filtered; GraphQL subscriptions over the same bridge if cheap. (F14)
4. ~~`ion.event.*` metrics~~ (✅ 2026-07-06) + DLQ admin surface (failed-deliveries view, retry). (F7, F18)

### Phase 13 — Relational completeness (parity + schema engine)
1. GraphQL relationship traversal: nested object types resolved through the same `DataService.expand` machinery (batched, depth-capped). (F6 — the MCP half shipped 2026-07-06.)
2. `SchemaManager.removeRelationship` + snapshot prune of relationships + admin delete action. (F17)
3. Admin m2m link editing (chip list cell, junction editing in RecordSheet). (⚪)
4. ~~Decide + document PUT~~ (✅ PATCH-only, documented); migration rollback build-or-drop decision. (F8, F9)

### Phase 14 — Framework mode & vendored-logic blocks (**NEXT UP** — ADR-018, [plan](phase_14_implementation_plan.md))
Expanded far beyond the original "CLI grows up" scope by ADR-018 (2026-07-06), and **jumps the
queue ahead of Phases 12–13** (repo precedent: phases execute out of numeric order; the number is
kept so F-references stay valid). Framework-first distribution: `ion-drive init` scaffolds a
user-owned project (`server.ts` composition root + `/blocks/*` barrel), core serves the built
admin SPA, block manifests gain `actions`/`requires` with action/webhook catch-all routes
reflected into OpenAPI/MCP, `add` vendors block logic into `/blocks/<name>` (shadcn-style, never
overwritten), `dev` runs the user's entry under tsx watch, and the release pipeline (old Phase 11
item 6) is Tier 0. First logic-bearing block: invoicing ↔ Stripe. Absorbs **F20, F21, F22, F23,
F24**. Per the ADR-018 amendment, blocks also move to **their own repos** (`ionshift/block-<name>`)
resolved via a minimal registry index (+ direct URLs and local paths for block dev); `packages/blocks`
retires, and F22's block-authoring toolchain (`block new/validate`) is promoted to a **required**
deliverable. `ion-drive schema` UX polish rides along; `ion-drive diff` is the stretch item.

### Phase 15 — File storage
`StorageProvider` port + local-disk default + S3 plugin; `file`/`image` field type storing object keys; upload/download REST endpoints + signed URLs; admin grid file cells. (F16)

### Phase 16 — Multi-tenancy management
Tenant provisioning/lifecycle APIs on the system DB, request→tenant routing (header/subdomain), per-tenant migrations at boot, schema-per-tenant lighter mode, tenant-aware CLI. Big; needs its own plan + ADR. (F10)

### Phase 17 — Authorization depth
Field-level RBAC (column masking on read, reject on write), row-level policies (owner scoping via actor identity from Phase 12), policy editor in admin. (F12)

### Continuous (no phase)
External plugin packages (F19), complexity-warning cleanup, remaining admin polish (§1.5), performance benchmarks.

---

## Part 3 — Skills & agent instructions

Two distinct audiences. (A skill = a `.claude/skills/<name>/SKILL.md` workflow document that
Claude Code loads on demand; repo-level `CLAUDE.md` is always-on context.)

### 3.1 For contributors to this repo (`.claude/skills/` here)

| Skill | Why |
|:--|:--|
| **`surface-parity`** | The #1 recurring convention. Checklist for adding any data-layer capability: query-parser → DataService → REST → GraphQL → MCP → OpenAPI → client SDK → docs → tests. Phase 10's `expand` shipping REST-only (F6) is exactly the miss this prevents. |
| **`live-smoke`** | Every phase ended with an N-check live smoke, re-invented each time. Codify: boot against dev Postgres (`docker/docker-compose.yml`, port overridable via env), sign up first admin, mint API key, run checks, tear down. Becomes the seed for integration tests (Phase 11). |
| **`new-block`** | Authoring a catalog block: TS manifest with `satisfies BlockManifestInput` → `pnpm --filter @ionshift/ion-drive-blocks emit` → drift test → registry entry → getting-started catalog line (prevents F4-style drift). |
| **`finish-phase`** | The close-out ritual: ADR → `implementation_plan.md` status note → `CLAUDE.md` status section → roadmap pruning → memory follow-ups. Consistently done so far but only by convention. |

> ✅ All four skills were created 2026-07-06 under `.claude/skills/`.

`CLAUDE.md` itself is strong; the main gap it can't cover is *workflow* (the above), which is what skills are for.

### 3.2 For end users of the platform (shipped by `ion-drive init`) — product work, tracked as F24

- **`AGENTS.md` template** in the scaffold: tells the user's coding agent how to work with *their* Ion Drive backend — MCP endpoint URL, the query language (operators/search/pagination/expand), client-SDK idioms (thenable builder, typed errors), the preview-first schema-change contract (`dryRun` before apply), and the block workflow. This is the productization of "minimize boilerplate and context needed for AI-driven development."
- **Starter skills** in the scaffold (`.claude/skills/`): `ion-schema-change` (pull → edit → diff → push, always preview first, doctor for drift) and `ion-add-block` (list → preview → add, check dependencies). Small files, huge leverage for the target audience.
- Longer term: publish these from one source of truth (e.g. the CLI embeds them) so server versions and instructions can't drift.
