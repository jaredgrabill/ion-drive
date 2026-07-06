# Ion Drive — Post-Phase-10 Review: Findings & Roadmap

**Date:** 2026-07-06 · **Reviewed against:** [implementation_plan.md](implementation_plan.md),
the ADRs in [research/architecture-decisions.md](research/architecture-decisions.md), and the
product positioning in `CLAUDE.md` (ADR-017: application backend platform, "self-hosted
Firebase meets an infinitely configurable ERP", built for agentic-LLM development).

This document is the canonical backlog. It catalogs every gap, punt, and deliberately-deferred
item found in a full review of the codebase after Phase 10 shipped, and organizes them into
proposed future phases. When a phase ships, move its note into `implementation_plan.md` /
`CLAUDE.md` as usual and prune it here.

Legend: 🔴 broken/misleading today · 🟠 gap vs. our own stated conventions · 🟡 planned-but-missing capability · ⚪ polish.

---

## Part 1 — Findings

### 1.1 Broken or misleading as shipped 🔴

| # | Finding | Detail |
|:--|:--|:--|
| F1 | **No CI pipeline** | `.github/` does not exist at all. `ci.yml` was in the Phase 0 plan and was never created. Also missing: PR/issue templates, `SECURITY.md`, `CODE_OF_CONDUCT.md`. Every "tests pass" claim so far is local-only. |
| F2 | **`pnpm test:integration` is broken** | `packages/core/package.json` points at `vitest.integration.config.ts`, which does not exist. No `*.integration.test.ts` files exist anywhere. All end-to-end verification to date has been ad-hoc live smokes that were discarded afterward. |
| F3 | **Observability overlay overpromises** | `docker/docker-compose.observability.yml` header says "All pre-configured with Ion Drive dashboards", but the Grafana provisioning and Prometheus config mounts are commented out and the referenced files don't exist. As shipped: Prometheus never scrapes `/metrics`, Grafana has no datasources or dashboards, and Loki/Tempo reference config files that aren't mounted. |
| F4 | **Docs drift: block catalog** | `docs/getting-started.md` lists the catalog as "crm, invoicing, communications" — the `audit` block (Phase 9) is missing. |
| F5 | **No `.env.example`** | Config is env-driven (`ION_*`) but there is no discoverable example env file at the repo root or in `docker/`. |

### 1.2 Surface-parity gaps 🟠

Our own convention (`CLAUDE.md`): *a capability added to one surface should be reflected in
REST, GraphQL, MCP, and OpenAPI.* These violate it:

| # | Finding | Detail |
|:--|:--|:--|
| F6 | **`expand=` is REST-only** | Phase 10 implemented relationship expansion in `DataService`, exposed on REST list/getById. GraphQL has **no relationship traversal at all** (no nested object types, no `expand` arg — relations are bare FK scalars). MCP `query_data`/`get_record` have no `expand` parameter either. |
| F7 | **No `ion.event.*` metrics** | The event dispatcher emits an OTel span per delivery but no metric instruments; tasks have `ion.task.*` counters/histograms. `telemetry/metrics.ts` + `span-attributes.ts` need the matching instruments. |
| F8 | **PUT missing** | The original plan promised `PUT` + `PATCH`; only `PATCH` exists. Probably fine (partial update is the primary verb) — but it's an undocumented deviation. Decide: add a PUT full-replace route or record PATCH-only as deliberate in the REST docs. |
| F9 | **Migration `sql_down` is write-only** | Every migration records `sql_down`, but nothing ever reads it — there is no rollback API, CLI command, or admin surface. Either build rollback (careful: naive down-SQL loses data) or stop implying it ("history/rollback" in `schema-manager.ts` docs). |

### 1.3 Planned-but-missing platform capabilities 🟡

| # | Finding | Detail |
|:--|:--|:--|
| F10 | **Multi-tenancy is aspirational** | Positioning says "database-per-tenant by default"; the plan's verification scenarios (create tenant → isolated DB) are unmet. Today: `createTenantDb` exists but there is exactly one tenant DB from config — no tenant provisioning, routing, lifecycle, or per-tenant migrations. |
| F11 | **Actor identity** (carried from Phase 9) | No `created_by`/`updated_by` system fields; event payloads carry no `actorId`; `audit_log.changed_by` is always null; `_ion_migrations.applied_by` never populated. Requires threading `request.auth` through `DataService` writes on all three surfaces. |
| F12 | **Field-level RBAC** | `permission-engine.ts` says "field-level scoping is a future extension". Object-level only today. Row-level policies (owner-scoped reads) are also absent — relevant for the app-backend positioning. |
| F13 | **No rate limiting / brute-force protection** | CORS + helmet are wired; `@fastify/rate-limit` is not. Auth endpoints and the public data API have no throttle. |
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
| F23 | **Nothing is published** | No npm packages, no Docker Hub image, no release workflow/versioning (changesets or similar). Blocks F20–F22 and any real adoption. |
| F24 | **No agent-facing project instructions** | For a platform *built for agentic development*, `init` ships no `AGENTS.md`/`CLAUDE.md` template telling the user's coding agent how to talk to their Ion Drive backend (MCP endpoint, query language, schema-change workflow, SDK idioms). See Part 3. |

### 1.5 Deferred polish backlog ⚪

Carried from Phases 8–10 (see memory/ADR notes), still valid:

- **Admin:** m2m link editing (chip lists + junction rows); command-palette record search (global `q=`); logs export button; column pinning; "delete → Undo" toast; popover calendar date picker; stat-card trend deltas (needs persisted stats history); `vitest-axe` assertions (dep installed, unused).
- **Schema engine:** doctor's `AUTH_TABLES` allowlist is hardcoded (ask the `AuthProvider` for its tables); `renderDefaultExpression` treats any value ending in `)` as a SQL expression (needs an `isLiteral` escape hatch); no admin UI for snapshots (CLI-first by design — revisit).
- **Code health:** ~27 Biome cognitive-complexity warnings (schema engine, data-service, designer components, dashboard). A helper-extraction pass would clear most.
- **Docs:** `docs/deployment/kubernetes.md` (planned, never written); backup/restore guide; security hardening checklist; performance benchmarks (both promised under Phase 7 "Polish").

---

## Part 2 — Proposed future phases

Ordered by value-per-effort and dependency. Numbers continue from Phase 10.

### Phase 11 — Launch readiness (CI, tests, ops) — *fixes every 🔴*
1. GitHub Actions CI: lint, typecheck, unit tests, build on PR/push; a second job with a Postgres 17 service container running integration tests. (F1)
2. Real integration test suite: create `vitest.integration.config.ts` + codify the Phase 4/6/9/10 live smokes as repeatable `*.integration.test.ts` against Postgres. (F2)
3. Observability overlay that works: Prometheus scrape config for `/metrics`, Grafana datasource + starter dashboard provisioning, Loki/Tempo configs; or scale the header claim back to match. (F3)
4. Rate limiting via `@fastify/rate-limit`, config-gated (`ION_RATE_LIMIT_*`), stricter bucket on `/api/auth/*`. (F13)
5. Repo hygiene: `.env.example`, `SECURITY.md`, issue/PR templates; fix getting-started catalog drift. (F4, F5)
6. Release pipeline: changesets (or similar), npm publish workflow for `core`/`cli`/`client`/`blocks`, Docker image publish. (F23)
7. Docs: `deployment/kubernetes.md`, backup/restore, security checklist. (⚪)

### Phase 12 — Events to the edge (realtime, webhooks, identity)
1. Actor identity: `created_by`/`updated_by` system fields, actor threaded from `request.auth` through `DataService` on all surfaces, `actorId` in event payloads, `audit_log.changed_by` populated, `applied_by` on migrations. (F11)
2. First-class **webhooks**: `webhook` handler (HMAC-signed payloads, retry/backoff, delivery log), admin CRUD page, block-manifest support. (F15)
3. **Realtime subscriptions**: SSE endpoint (`/api/v1/events/stream?topics=data.contacts.*`) bridging the dispatcher, RBAC-filtered; GraphQL subscriptions over the same bridge if cheap. (F14)
4. `ion.event.*` metrics + DLQ admin surface (failed-deliveries view, retry). (F7, F18)

### Phase 13 — Relational completeness (parity + schema engine)
1. GraphQL relationship traversal: nested object types resolved through the same `DataService.expand` machinery (batched, depth-capped); MCP `query_data`/`get_record` gain `expand`. (F6)
2. `SchemaManager.removeRelationship` + snapshot prune of relationships + admin delete action. (F17)
3. Admin m2m link editing (chip list cell, junction editing in RecordSheet). (⚪)
4. Decide + document PUT and migration rollback story. (F8, F9)

### Phase 14 — Standalone developer experience (CLI grows up)
1. `ion-drive init` scaffolds a runnable project: `docker-compose.yml` (server + Postgres), `.env`, client starter, **and an agent-instructions file** (see Part 3). (F21, F24)
2. `ion-drive dev` runs that compose stack (or a published dist) instead of the monorepo filter. (F20)
3. Block authoring: `ion-drive block new/validate` against the exported Zod schema. (F22)
4. `ion-drive schema` UX polish informed by real use (e.g. `--prune` parity, snapshot in admin if demanded).

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

`CLAUDE.md` itself is strong; the main gap it can't cover is *workflow* (the above), which is what skills are for.

### 3.2 For end users of the platform (shipped by `ion-drive init`) — product work, tracked as F24

- **`AGENTS.md` template** in the scaffold: tells the user's coding agent how to work with *their* Ion Drive backend — MCP endpoint URL, the query language (operators/search/pagination/expand), client-SDK idioms (thenable builder, typed errors), the preview-first schema-change contract (`dryRun` before apply), and the block workflow. This is the productization of "minimize boilerplate and context needed for AI-driven development."
- **Starter skills** in the scaffold (`.claude/skills/`): `ion-schema-change` (pull → edit → diff → push, always preview first, doctor for drift) and `ion-add-block` (list → preview → add, check dependencies). Small files, huge leverage for the target audience.
- Longer term: publish these from one source of truth (e.g. the CLI embeds them) so server versions and instructions can't drift.
