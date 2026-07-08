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
| F6 | ✅ **`expand=` is REST-only** | Fully fixed: MCP half 2026-07-06; GraphQL half 2026-07-07 (Phase 13 / ADR-020) — relation keys become nested fields resolved through a per-request batching loader over the shared `DataService.hydrateRelation`, with a 12-level depth cap. Reverse traversal (`<fkObj>_by_<rel>`) landed on every surface at once. |
| F7 | ✅ **No `ion.event.*` metrics** | Fixed 2026-07-06: `ion.event.published` counter, `ion.event.deliveries` counter (`ion.outcome` attr), `ion.event.delivery.duration` histogram — recorded in `OutboxBus.publish` and the dispatcher, documented in `docs/concepts/events.md`. |
| F8 | ✅ **PUT missing** | Decided 2026-07-06: PATCH-only is deliberate (a stale full-replace would silently null runtime-added fields); documented in `docs/api/rest.md`. |
| F9 | ✅ **Migration `sql_down` is write-only** | Resolved 2026-07-07 (Phase 13 / ADR-020): **no rollback API, by decision** — `sql_down` is advisory documentation; recovery is declarative (snapshot pull/diff/push, relationships included since Phase 13) plus backups/PITR. |

### 1.3 Planned-but-missing platform capabilities 🟡

| # | Finding | Detail |
|:--|:--|:--|
| F10 | **Multi-tenancy is aspirational** | Positioning says "database-per-tenant by default"; the plan's verification scenarios (create tenant → isolated DB) are unmet. Today: `createTenantDb` exists but there is exactly one tenant DB from config — no tenant provisioning, routing, lifecycle, or per-tenant migrations. |
| F11 | ✅ **Actor identity** (carried from Phase 9) | Fixed 2026-07-06 (Phase 12 / ADR-019): ambient `AsyncLocalStorage` request actor (no signature threading); `created_by`/`updated_by` system fields + boot migration; `actor` on event payloads; `persist_event` gains `payload.actorId`; `_ion_migrations.applied_by` populated. Remaining: point the audit block's `changed_by` map at `payload.actorId` in `ion-drive-blocks`. |
| F12 | **Field-level RBAC** | `permission-engine.ts` says "field-level scoping is a future extension". Object-level only today. Row-level policies (owner-scoped reads) are also absent — relevant for the app-backend positioning. |
| F13 | ✅ **No rate limiting / brute-force protection** | Fixed 2026-07-06: `@fastify/rate-limit`, config-gated `ION_RATE_LIMIT_*` (default on: 300/min global per IP, 20/min on `/api/auth/*` via an independent keyed bucket), `/health`+`/metrics` exempt. Live-smoked against Postgres. |
| F14 | ✅ **No realtime** | Fixed 2026-07-06 (Phase 12): `GET /api/v1/events/stream` (SSE, per-event RBAC) via `RealtimeBridge`; client SDK `ion.events.stream()`; admin live feed. GraphQL `Subscription.events` landed 2026-07-07 (Phase 13) over the same bridge. |
| F15 | ✅ **No outbound webhooks** | Fixed 2026-07-06 (Phase 12): `_ion_webhooks` + `WebhookManager` projecting webhooks onto dispatcher consumer groups (`webhook:<id>`); HMAC-signed payloads (`x-ion-signature`), exponential retry backoff, ledger as delivery log; REST CRUD + test-fire, admin page, block-manifest `webhooks`. |
| F16 | ✅/🟡 **No file/blob storage** | Infrastructure half shipped 2026-07-07 (ADR-021): `StorageProvider` port + filesystem `LocalStorage` default in core (`STORAGE_SERVICE`, `ION_STORAGE_DIR`) + `@ion-drive/plugin-storage-s3` (AWS/MinIO/R2, pre-signed URLs). Remaining = Phase 15 proper: `file`/`image` field type, upload/download REST endpoints, signed-URL fallback, admin grid file cells. |
| F17 | ✅ **`removeRelationship` missing** | Fixed 2026-07-07 (Phase 13 / ADR-020): preview-first `removeRelationship` (data-loss warnings, block protection + force), `DELETE /api/v1/schema/objects/:name/relationships/:relName`, MCP `remove_relationship` (+ `add_relationship`, which was also missing), snapshot `--prune` removes relationships, admin delete dialog. |
| F18 | ✅ **Delivery DLQ has no surface** | Fixed 2026-07-06 (Phase 12): `GET /api/v1/events[,/deliveries]` (status/consumer/`dead=true`) + `POST /deliveries/retry`; admin Events page with retry. Alerting still open (a webhook on failure topics, or Prometheus rules over `ion.event.deliveries`). |
| F19 | ✅ **External plugin packages don't exist yet** | Shipped 2026-07-07 (ADR-021) as monorepo packages (owner declined separate repos): `@ion-drive/plugin-redis` (cache + opt-in Streams bus), `@ion-drive/plugin-sendgrid`, `@ion-drive/plugin-storage-s3`. Independently versioned (outside the fixed group); each needs a one-time npm Trusted Publisher registration before first publish. SMTP/RabbitMQ remain build-on-demand. |

### 1.4 CLI & end-user developer experience ✅ (Phase 14, 2026-07-06)

| # | Finding | Detail |
|:--|:--|:--|
| F20 | ~~**`ion-drive dev` is monorepo-only**~~ | ✅ 2026-07-06 — `dev` detects a scaffolded project (`server.ts` + core dep), brings up the compose Postgres best-effort, and runs `tsx watch server.ts` (hot-reload of `server.ts` + `/blocks`); the monorepo contributor path remains the fallback. |
| F21 | ~~**`init` doesn't scaffold infrastructure**~~ | ✅ 2026-07-06 — `init [dir]` scaffolds the full framework project: composition root, blocks barrel, `.env` (generated secrets) + `.env.example` (hardening knobs), `docker-compose.yml`, tsconfig, README, client starter. |
| F22 | ~~**No block-authoring support**~~ | ✅ 2026-07-06 — `ion-drive block new/validate/pack` (scaffold, platform-Zod validation via project-first core import, artifact packing with `code/` embedded). Official blocks live in the separate `jaredgrabill/ion-drive-blocks` repo (ADR-018 re-amendment: single repo, registry index in-repo). |
| F23 | 🟡 **Nothing is published** | Pipeline built 2026-07-06 (Phase 14 Tier 0); packages verified installable via tarballs (the whole Phase 14 live loop ran a scaffolded project on them). Remaining: the **first real publish** (owner-run — needs `NPM_TOKEN` secret + `v0.x` tag), Docker image not yet pushed, and the `jaredgrabill/ion-drive-blocks` repo needs pushing to GitHub (the CLI's default registry URL points at it). |
| F24 | ~~**No agent-facing project instructions**~~ | ✅ 2026-07-06 — `init` ships `AGENTS.md` (MCP endpoint, query language, preview-first schema contract, SDK idioms, block rules) plus `.claude/skills/{ion-schema-change,ion-add-block}`. |

### 1.5 Deferred polish backlog ⚪

Carried from Phases 8–10 (see memory/ADR notes), still valid:

- **Admin:** ~~m2m link editing (chip lists + junction rows)~~ (✅ 2026-07-07 — Phase 13: read-only chip columns in the grid, chip+picker junction editor in the RecordSheet over the link API); ~~command-palette record search (global `q=`)~~ (✅ 2026-07-06 — debounced `q=` fan-out across the first 8 non-system objects; selecting a result opens the object grid with the search prefilled); ~~logs export button~~ (✅ 2026-07-06 — JSON/CSV export of the filtered view); column pinning; "delete → Undo" toast; popover calendar date picker; stat-card trend deltas (needs persisted stats history); ~~`vitest-axe` assertions (dep installed, unused)~~ (✅ 2026-07-06 — matcher wired in vitest.setup.ts; `src/a11y.test.tsx` runs axe over Button/form fields/Checkbox+Switch/EmptyState/Tabs/Dialog/Login, zero violations found).
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

### Phase 12 — Events to the edge (realtime, webhooks, identity) ✅ SHIPPED 2026-07-06 (ADR-019, [plan](phase_12_implementation_plan.md))
All four items landed (F11, F15, F14 minus GraphQL subscriptions, F18) plus the
pre-phase shutdown/port-release fix. Verified by 4 new integration scenarios
(15 total) against real Postgres + a 5-check boot-migration live smoke.
Follow-ups:
- **Audit block:** map `changed_by: payload.actorId` in the `ion-drive-blocks`
  repo's audit manifest (one-line change; the core token exists).
- ~~**GraphQL subscriptions** over the same bridge~~ (✅ 2026-07-07, Phase 13 —
  `Subscription.events` over yoga GraphQL-SSE, shared per-event RBAC filter).
- **DLQ alerting** (notify on dead letters) — composable today via a webhook
  or Prometheus rules on `ion.event.deliveries`; revisit if a first-class
  notifier earns its keep.
- Admin Events page could deep-link a webhook's delivery history
  (`consumer=webhook:<id>` prefill).

### Phase 13 — Relational completeness (parity + schema engine) ✅ SHIPPED 2026-07-07 (ADR-020, [plan](phase_13_implementation_plan.md))
All four items landed (F6's GraphQL half, F17, the admin m2m polish, F9 decided
as no-rollback) **plus** the two parked deferrals: GraphQL subscriptions over
the Phase 12 bridge and GraphQL mutations for block actions. Also new beyond
the plan: reverse traversal (`<fkObj>_by_<rel>` expand keys on every surface),
a first-class m2m link write API (REST/GraphQL/MCP/SDK/admin +
`data.<object>.linked|unlinked` events), and a snapshot scoping fix
(relationships now match by (source, name), not name alone). Verified by 6 new
integration scenarios (21 total) against real Postgres. Follow-ups:
- Pagination/filtering *within* an expansion is deliberately out of scope
  (query the child object directly); revisit only on real demand.
- The audit block's `data.#` subscription now also receives `linked`/`unlinked`
  payloads (no before/after/diff) — its field map handles them as nulls, but a
  dedicated link-audit row shape could be nicer (ion-drive-blocks follow-up).

### Phase 14 — Framework mode & vendored-logic blocks ✅ SHIPPED 2026-07-06 (ADR-018, [plan](phase_14_implementation_plan.md))
All tiers complete and verified end-to-end (a scaffolded project on tarball installs ran the
whole loop: init → dev → registry add → local-path add with vendored Stripe code → action via
REST + MCP → signed/replay-protected webhook → hot-reload edit → guarded remove → RBAC).
Absorbed **F20, F21, F22, F24**; F23 remains 🟡 pending the owner-run first publish + pushing
`jaredgrabill/ion-drive-blocks`. Executed under the ADR-018 **re-amendment**: official blocks live in one
`jaredgrabill/ion-drive-blocks` repo (registry index in-repo) instead of repo-per-block. Follow-ups:
- **`ion-drive diff <block>`** (Tier 3D stretch — slipped as planned; the ledger's manifest
  snapshot is the base-version anchor).
- **CI-automated scaffold boot**: the framework path is unit/integration-covered, but a CI job
  that `npm install`s the real scaffold against packed workspace tarballs is still manual.
- `add` cosmetic: a local-path target is labeled "(dependency)" in the plan preview.
- Force-reinstall re-runs `seed` (documented "re-apply" semantics — revisit if it bites).

### Phase 15 — File storage
~~`StorageProvider` port + local-disk default + S3 plugin~~ (✅ 2026-07-07, ADR-021). Remaining: `file`/`image` field type storing object keys; upload/download REST endpoints + signed URLs; admin grid file cells. (F16)

### Phase 16 — Multi-tenancy management
Tenant provisioning/lifecycle APIs on the system DB, request→tenant routing (header/subdomain), per-tenant migrations at boot, schema-per-tenant lighter mode, tenant-aware CLI. Big; needs its own plan + ADR. (F10)

### Phase 17 — Authorization depth
Field-level RBAC (column masking on read, reject on write), row-level policies (owner scoping via actor identity from Phase 12), policy editor in admin. (F12)

### Continuous (no phase)
~~External plugin packages (F19)~~ (✅ 2026-07-07), complexity-warning cleanup, remaining admin polish (§1.5), performance benchmarks. Plugin follow-ups if demanded: SMTP provider, RabbitMQ bus, a Redis-backed realtime bridge (the SSE stream stays outbox-only when the Redis bus is active).

**TODO — codify the plugin-redis live smoke as an integration test** (deferred 2026-07-07, owner-approved for later): add a Redis service container to `ci.yml`'s integration job and a `redis.integration.test.ts` in `packages/plugin-redis` (skip cleanly when `ION_REDIS_URL` is unset) covering the real-ioredis adapter (KV/TTL/SCAN, stream groups/PEL/claim), a `createServer` boot with `redisPlugin({ bus: true })`, event publish → webhook delivery through the Redis dispatcher, and the outbox-surface-off assertion. The 34-check ad-hoc smoke from the ADR-021 session is the spec.

---

## Part 3 — Skills & agent instructions

Two distinct audiences. (A skill = a `.claude/skills/<name>/SKILL.md` workflow document that
Claude Code loads on demand; repo-level `CLAUDE.md` is always-on context.)

### 3.1 For contributors to this repo (`.claude/skills/` here)

| Skill | Why |
|:--|:--|
| **`surface-parity`** | The #1 recurring convention. Checklist for adding any data-layer capability: query-parser → DataService → REST → GraphQL → MCP → OpenAPI → client SDK → docs → tests. Phase 10's `expand` shipping REST-only (F6) is exactly the miss this prevents. |
| **`live-smoke`** | Every phase ended with an N-check live smoke, re-invented each time. Codify: boot against dev Postgres (`docker/docker-compose.yml`, port overridable via env), sign up first admin, mint API key, run checks, tear down. Becomes the seed for integration tests (Phase 11). |
| **`new-block`** | Authoring a catalog block: TS manifest with `satisfies BlockManifestInput` → `pnpm --filter @ion-drive/blocks emit` → drift test → registry entry → getting-started catalog line (prevents F4-style drift). |
| **`finish-phase`** | The close-out ritual: ADR → `implementation_plan.md` status note → `CLAUDE.md` status section → roadmap pruning → memory follow-ups. Consistently done so far but only by convention. |

> ✅ All four skills were created 2026-07-06 under `.claude/skills/`.

`CLAUDE.md` itself is strong; the main gap it can't cover is *workflow* (the above), which is what skills are for.

### 3.2 For end users of the platform (shipped by `ion-drive init`) — product work, tracked as F24

- **`AGENTS.md` template** in the scaffold: tells the user's coding agent how to work with *their* Ion Drive backend — MCP endpoint URL, the query language (operators/search/pagination/expand), client-SDK idioms (thenable builder, typed errors), the preview-first schema-change contract (`dryRun` before apply), and the block workflow. This is the productization of "minimize boilerplate and context needed for AI-driven development."
- **Starter skills** in the scaffold (`.claude/skills/`): `ion-schema-change` (pull → edit → diff → push, always preview first, doctor for drift) and `ion-add-block` (list → preview → add, check dependencies). Small files, huge leverage for the target audience.
- Longer term: publish these from one source of truth (e.g. the CLI embeds them) so server versions and instructions can't drift.
