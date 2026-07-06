# Ion Drive — Architecture Decision Records (ADR)

> This document tracks key architectural decisions made during the design and implementation of Ion Drive.

---

## ADR-001: Use Fastify as the Backend Framework

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Need a TypeScript backend framework that supports dynamic route registration at runtime, high performance, and plugin-based encapsulation for multi-tenancy.
**Decision:** Use Fastify over NestJS and Hono.
**Rationale:**
- Fastify's plugin system natively supports dynamic route registration during the registration phase
- Near-highest performance in Node.js framework benchmarks
- JSON Schema-native validation maps directly to OpenAPI spec generation
- Plugin encapsulation model perfect for tenant isolation
- Low boilerplate compared to NestJS's decorator/module system
**Consequences:**
- Must handle route re-registration when schema changes (plugin scope refresh)
- No decorator-based DI — need to implement our own service locator or simple DI pattern
- Cannot modify routes after server.listen() — must plan for graceful re-registration

---

## ADR-002: Use Kysely as the Query Builder / Data Access Layer

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Need a TypeScript database access layer that supports runtime DDL operations, dynamic multi-tenant schema switching, and raw SQL for complex operations.
**Decision:** Use Kysely over Prisma, Drizzle, and TypeORM.
**Rationale:**
- Only query builder that handles dynamic schemas without static file generation
- Schema Builder API for programmatic CREATE/ALTER/DROP TABLE
- Clean `search_path` management for multi-tenancy
- `sql.table()` and `sql.ref()` for safe identifier injection
- Transparent SQL — LLM agents can read and understand code
**Consequences:**
- Lose compile-time type safety for tenant data tables (expected — handled by runtime validation)
- System tables (Ion Drive internals) will be fully typed
- Team must be comfortable with SQL-aware query building (not ORM-style abstraction)

---

## ADR-003: Use Better Auth as Default Authentication Provider

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Need authentication that is fully self-hosted, stores data in the user's database, has no per-user fees, and is TypeScript-native.
**Decision:** Use Better Auth as the default, with a pluggable AuthProvider interface for swapping to WorkOS/Auth0/Clerk.
**Rationale:**
- Self-hosted-first aligns with Ion Drive's core positioning
- Data stays in user's PostgreSQL database
- No vendor lock-in or per-user pricing
- Plugin system supports 2FA, passkeys, magic links, multi-tenancy
- TypeScript-native library
**Consequences:**
- Users are responsible for their own security patching and session management
- Enterprise SSO (SAML/SCIM) requires either Better Auth plugin or swapping to WorkOS
- Must document the adapter swap process clearly

---

## ADR-004: Use OpenTelemetry + Grafana Stack for Observability

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Need built-in observability (logs, metrics, traces) that is vendor-neutral, cost-effective, and works self-hosted with short TTL.
**Decision:** OpenTelemetry SDK → OTel Collector → Grafana Loki (logs) + Prometheus (metrics) + Tempo (traces) + Grafana (visualization).
**Rationale:**
- Vendor-neutral — users can swap to Datadog/New Relic by changing OTel Collector config
- Loki is label-indexed (not full-text), dramatically cheaper than Elasticsearch
- Short TTL via Loki compactor with configurable retention
- All components are open source with no licensing costs
- Pre-built dashboards can ship with Ion Drive (inspired by .NET Aspire)
**Consequences:**
- Self-hosted observability adds operational complexity
- Must ship as optional Docker Compose overlay (not required for core functionality)
- Need to maintain Grafana dashboard JSON files as the product evolves

---

## ADR-005: Use React + Vite SPA for Admin Console

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Need an admin console that is decoupled from the backend, easy to deploy, and provides a rich interactive experience.
**Decision:** React 19 + Vite SPA, not Next.js or server-rendered.
**Rationale:**
- Admin consoles don't need SSR/SEO
- Static files can be served by Fastify itself or any CDN/nginx
- Decoupled from backend — pure API consumer
- React has the most LLM training data for AI-assisted development
- Vite provides instant HMR and fast builds
**Consequences:**
- No server-side rendering for admin pages
- Must handle auth state client-side
- Initial load may be larger than SSR equivalent (mitigated by code splitting)

---

## ADR-006: Use shadcn-Style Distribution for Building Blocks

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Need a reusable module system where users own their code, can customize freely, and avoid dependency hell.
**Decision:** Custom registry + CLI following the shadcn distribution pattern (copy source code into project).
**Rationale:**
- Code ownership — users can modify everything
- No dependency version conflicts
- Composable — blocks can reference other blocks
- CLI-driven — `ion-drive add crm` pulls and installs
- Future marketplace support without architectural changes
**Consequences:**
- Updates are opt-in (shown as diffs, never auto-applied)
- Users must manually manage block updates
- Need to build CLI tooling and registry infrastructure

---

## ADR-007: PostgreSQL as the Single Database Engine

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Need a database that supports runtime DDL, JSONB for flexible data, schemas for multi-tenancy, rich indexing, and extensions.
**Decision:** PostgreSQL 17 as the only supported database.
**Rationale:**
- JSONB for flexible/semi-structured data within typed columns
- Schema-level isolation for multi-tenancy
- Extension ecosystem (pgvector for RAG, pg_cron for scheduling)
- Most mature open-source relational database
- Excellent TypeScript tooling support (Kysely, pg, etc.)
**Consequences:**
- No MySQL/SQLite/MongoDB support (intentional — reduces complexity)
- Users must run PostgreSQL (included in Docker Compose)
- Must target PostgreSQL 15+ for optimal feature support

---

## ADR-008: Multi-Tenancy via Database-per-Tenant (Default)

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Need strong tenant data isolation for a platform that hosts multiple organizations.
**Decision:** Database-per-tenant as the default isolation model, with schema-per-tenant as a lighter-weight option.
**Rationale:**
- Strongest isolation — no risk of data leakage between tenants
- Independent backup/restore per tenant
- Independent scaling per tenant
- Clean connection pool management
- Schema-per-tenant available for simpler/cheaper deployments
**Consequences:**
- More PostgreSQL databases to manage
- Connection pool management complexity
- Must implement tenant routing in middleware
- Higher resource usage than shared-schema (RLS) approaches

---

## ADR-009: Dynamic API Surface via Runtime Reflection (not per-object registration)

**Status:** Accepted
**Date:** 2026-07-03
**Context:** Objects are defined at runtime, but Fastify cannot register new routes after `server.listen()`, and rebuilding a GraphQL schema by hand per object is not viable. We need REST, GraphQL, MCP, and OpenAPI surfaces that stay correct as objects are created and dropped — ideally without a restart.
**Decision:** Generate the API surface by *reflecting* the Schema Registry at request time rather than registering a static route/type per object.
- **REST:** a single set of parameterized routes (`/api/v1/data/:object`, `/:object/:id`, `/:object/bulk`) resolves the target object from the registry per request. A newly created object's endpoints are live immediately. Fastify's router resolves the static `bulk` segment ahead of the `:id` parameter, so they never collide.
- **GraphQL:** the schema is built from the registry and cached by the registry's version number; graphql-yoga calls the schema factory per request, so a version bump (from any schema change) transparently rebuilds it.
- **OpenAPI / MCP:** already generated on demand from the registry; MCP runs stateless Streamable HTTP (fresh server+transport per request) reading live registry state.
**Rationale:**
- Delivers the core "create object → endpoints work instantly" promise on Fastify without route re-registration or process restarts.
- One code path per verb instead of N routes × M objects; less memory, simpler reasoning.
- Correctness is enforced at request time by the registry + DataService validation, consistent with the dynamic-typing stance in ADR-002.
**GraphQL engine — graphql-js directly, not Pothos:** The implementation plan floated Pothos, but Pothos's value is *compile-time* type inference, which is meaningless for objects whose shape is only known at runtime — using it purely dynamically means fighting its generics with `any`. graphql-js type constructors (`GraphQLObjectType`, etc.) express a reflected schema cleanly, with `graphql-yoga` providing the HTTP layer and GraphiQL. Fewer dependencies, less indirection.
**Consequences:**
- No per-route JSON Schema validation from Fastify; request validation lives in the DataService/schema layer. (OpenAPI is still generated for docs/clients.)
- GraphQL schema is rebuilt on every registry version change — cheap, but relies on the registry's version bump being correct on every mutation.
- MCP rebuilds a server instance per request (stateless); acceptable now, revisit if tool-list construction becomes a hotspot.
- Static per-object typed SDK generation, if ever wanted, must come from the OpenAPI/GraphQL introspection outputs, not from Fastify route definitions.

---

## ADR-010: Better Auth (default) behind a pluggable AuthProvider; Ion-Drive-owned RBAC & secrets

**Status:** Accepted
**Date:** 2026-07-04
**Context:** Phase 4 needs authentication, authorization, API keys, and encrypted secrets for a self-hosted platform. Auth must be swappable (WorkOS/Auth0/Clerk) but work out of the box.
**Decision:** Integrate **Better Auth** as the concrete default auth provider, wrapped behind an `AuthProvider` interface (`auth/types.ts`). RBAC, API keys, and secrets are **Ion-Drive-owned** (not delegated to the provider), since object-level permissions are application-specific.
**Rationale:**
- Better Auth is self-hosted, TypeScript-native, stores users in our Postgres, and ships 2FA/passkeys/social behind one library. Its programmatic migration runner (`better-auth/db/migration`) creates its tables at boot — no CLI step.
- The `AuthProvider` seam keeps the provider swappable; the rest of the platform only sees `getSession`/`registerRoutes`.
- RBAC as our own concern: roles carry permission grants (resource × action; `manage`/`*` are supersets) in `_ion_roles`; `PermissionEngine` evaluates. Enforcement is a global `onRequest` hook (coarse for GraphQL/MCP) plus per-route `requirePermission` guards, gated by `ION_REQUIRE_AUTH` so dev/first-run stays open.
- API keys are hashed (SHA-256) high-entropy tokens (`iond_<prefix>_<secret>`) bound to an optional user and/or role. Secrets are AES-256-GCM encrypted at rest; list never returns plaintext.
- First-run bootstrap: the first user to sign up is auto-granted `admin` (via a Better Auth `databaseHooks.user.create.after`), avoiding a chicken-and-egg lockout.
**Dependency note:** Better Auth 1.6 depends on Zod 4 and Kysely ≥0.28 (bundled in its own subtree). Our code stays on **Zod 3**; we bumped **core Kysely 0.27 → 0.28** to satisfy `@better-auth/core`'s peer. The MCP SDK already accepts `zod ^3.25 || ^4.0`, so the two Zod majors coexist without crossing boundaries.
**Consequences:**
- Two Zod majors in the tree (ours v3, Better Auth's v4). Fine as long as Zod values don't cross the boundary — they don't.
- GraphQL/MCP RBAC is transport-coarse today (a single gate); field/operation-level RBAC is a future refinement.
- Enforcement defaults **off** (`ION_REQUIRE_AUTH` unset) so local dev and Phase 2 smokes keep working; production deployments must turn it on. In production, `ION_ENCRYPTION_KEY` is required (no dev fallback).
- Better Auth requires an `Origin` header on state-changing requests (browsers send it; server-to-server clients must set it).

---

## ADR-011: Admin console — React 19 + Vite SPA, dependency-light UI

**Status:** Accepted
**Date:** 2026-07-04
**Context:** Phase 3 needs a functional admin console for schema design, data browsing/editing, users/RBAC, secrets, and API keys. The user asked for "functional now, polish later"; the Airtable-grade grid is explicitly deferred.
**Decision:** Build a React 19 + Vite SPA (`packages/admin`) with TanStack Router (code-based) + TanStack Query, a small hand-rolled UI-primitive set styled by CSS-variable design tokens wired into Tailwind v4 via `@theme inline`, and a thin typed `lib/api.ts` client. Auth uses the Better Auth HTTP endpoints directly (no SDK); session state is read from `/api/v1/me`.
**Rationale:**
- Decoupled SPA, pure API consumer (ADR-005). No SSR needed for an admin.
- Hand-rolled primitives (Button/Input/Card/Dialog/Badge/…) avoid pulling a component library now while matching shadcn shape, so shadcn can drop in later.
- A single global `/api` Vite proxy to the core server keeps cookies same-origin in dev.
**Consequences:**
- The DataGrid is utilitarian (paginated table + per-field form), not a spreadsheet — a richer grid is a later phase.
- No component-library accessibility guarantees yet; primitives are minimal.
- Auth cookie flow depends on the Vite dev proxy in development; production will serve the built SPA from the core server (not yet wired).

---

## ADR-012: Phase 5 — OpenTelemetry observability (manual instrumentation) + a cron task engine

**Status:** Accepted
**Date:** 2026-07-04
**Context:** Phase 5 adds built-in observability and background/scheduled tasks. ADR-004 already committed to OpenTelemetry → Grafana (Loki/Prometheus/Tempo) as an optional overlay. Two implementation questions had to be resolved: (a) how to instrument a Node/ESM Fastify app whose telemetry SDK is started *inside* the already-running process, and (b) what to build tasks on.
**Decision — Telemetry (`telemetry/`):** Start the OpenTelemetry `NodeSDK` from config (`ION_OTEL_*` / `ION_METRICS_*`) and emit signals via **manual instrumentation**, not the auto-instrumentation packages.
- **Traces + metrics + logs** are wired conditionally: traces → OTLP/HTTP; metrics → a Prometheus scrape endpoint served through Fastify at `/metrics` (default on, independent of `otelEnabled`) and/or OTLP push; logs → OTLP/HTTP via a pino→OTel bridge stream.
- Per-request spans and `ion.http.server.*` metrics come from **global Fastify hooks** (`installRequestTracing`, added directly on the instance like `installSessionMiddleware`/`installRbacEnforcement` — *not* an encapsulated plugin, which would scope the hooks and miss sibling routes). Custom metrics (`ion.schema.changes`, `ion.task.*`) are recorded at the relevant call sites against the global MeterProvider, so they are cheap no-ops when telemetry is off.
- The Prometheus exporter runs with `preventServerStart` and is serialized on demand by the `/metrics` route (one port, no second HTTP server). `resourceDetectors: []` keeps the resource fully synchronous, avoiding "async attributes not settled" warnings during synchronous scrape serialization.
**Rationale — why manual, not auto-instrumentation:** The default runtime path starts the SDK inside `createServer()` *after* http/pg/fastify are already imported, so require-patch auto-instrumentation cannot retroactively hook them under ESM without a `--import` preloader. Manual per-request spans give correct, deterministic request traces with no loader gymnastics and no double-spanning; operators who want deep auto-instrumentation can still preload the SDK. Serving Prometheus in-process also makes metrics verifiable with a plain `GET /metrics`, no collector required.
**Decision — Task engine (`tasks/`):** A small pluggable engine: `TaskStore` (`_ion_tasks` + `_ion_task_runs`), a `TaskRunner` with a handler registry (built-ins `noop`, `log`, `http_request`) that executes under an abort/timeout and records each run (status, duration, result/error) plus a span and `ion.task.*` metrics, and a `TaskScheduler` built on **croner** (zero-dep, DST-aware; `protect` prevents overlapping runs). A `TaskEngine` facade validates definitions (known handler type, valid cron, unique name) and keeps the scheduler in sync on every mutation. Exposed at `/api/v1/tasks` (RBAC resource `tasks`, self-guarding like the admin routes), gated by `ION_TASKS_ENABLED`.
**Rationale — croner over node-cron/agenda/BullMQ:** No Redis/broker dependency for a self-hosted single-node default; croner is TypeScript-native, zero-dependency, DST-correct, validates patterns eagerly, and supports 6-field (seconds) expressions. A distributed queue can be added later behind the same handler interface without changing the API.
**Consequences:**
- Metrics work out of the box (Prometheus `/metrics`) even without any OTLP backend; traces/logs require `ION_OTEL_ENABLED=1` and an OTLP endpoint.
- Task execution is in-process and single-node; there is no cross-instance locking yet, so running multiple replicas would double-fire schedules (documented; revisit with a DB advisory-lock or external queue when HA is needed).
- Two config flags default **on** (`ION_METRICS_ENABLED`, `ION_TASKS_ENABLED`); these use a real boolean env parser (not `z.coerce.boolean`, which treats `"false"` as truthy) so they can actually be switched off.
- `recordSchemaChange` is called from the schema routes; deeper coverage (per-DB-query spans) is left to the optional auto-instrumentation preload path.

---

## ADR-013: Phase 6 — Building blocks as server-applied manifests + a shadcn-style CLI

**Status:** Accepted
**Date:** 2026-07-05
**Context:** ADR-006 committed to a shadcn-style distribution model for "building blocks" — reusable business domains (CRM, invoicing, …) users own and customize. Phase 6 had to decide what a block actually *is* for a **runtime-dynamic backend** (not a static React app), how it installs, and how the CLI and server divide responsibility without coupling the engine to any example content.
**Decision — a block is a self-contained manifest the server applies through its own APIs.** A `block.json` manifest (the `registry-item.json` analog) declares data **objects**, **relationships**, **seed** data, scheduled **tasks**, RBAC **roles**, and inter-block **dependencies** (the `registryDependencies` analog). Installing a block is scripted execution of the *same* operations a human performs: `SchemaManager.createObject`/`addRelationship`, `DataService.bulkCreate`, `TaskEngine.create`, `RoleManager.create`. So a block can do nothing the platform APIs can't, and REST/GraphQL/MCP light up for its objects instantly with zero extra wiring.
- **Runtime (`packages/core/src/blocks/`):** `BlockEngine` facade over a Zod-validated `block-manifest` parser, a step-wise `BlockInstaller` (objects → relationships → seed → tasks → roles; each idempotent-friendly — existing items are skipped and reported), and a `_ion_blocks` ledger (`BlockStore`) recording the manifest snapshot + created objects for clean uninstall. Exposed at **`/api/v1/blocks`** (`block-routes.ts`, RBAC resource `blocks`, self-guarding), gated by `ION_BLOCKS_ENABLED` (default on). `dryRun` produces the same report without writing (preview).
- **Content-agnostic engine:** the server installs *whatever validated manifest it is handed*; it does **not** bundle the catalog. This avoids any `core → blocks` package dependency (and the resulting cycle) and keeps the runtime free of example content. Dependency invariants are still enforced server-side: install refuses until a block's `dependencies` are present; uninstall refuses while dependents remain, and (without `dropData`) while any created table holds rows.
- **Distribution (`packages/blocks` = `@ionshift/ion-drive-blocks`):** the official catalog (`crm`, `invoicing`→crm, `communications`). **TypeScript is the source of truth** — each manifest is authored as `satisfies BlockManifestInput` so the compiler validates every column type and shape; an `emit` script writes the distributable `block.json` artifacts and a test asserts they never drift. Depends on core for **types only** (`import type`, erased), so the DAG is `core → blocks → cli` with no runtime coupling.
- **CLI (`packages/cli`):** `init`/`list`/`add`/`remove`/`dev`. `add` resolves the dependency closure client-side (recursive fetch + topological sort, pruning already-installed deps — mirroring how shadcn resolves `registryDependencies`), previews the plan, then POSTs each manifest in order to the server. Sources are the bundled catalog (offline default) or any remote `block.json` URL. Output is **space-themed** (nebula-gradient banner, cosmic palette, moon-phase orbit spinner, rounded panels, aligned tables) — the polished feel of npm/docker/claude, chalk-only with no extra deps.
**Rationale:**
- Server-applied manifests fit a dynamic backend far better than the file-copy model shadcn uses for a frontend: there are no component files to vendor; the "code you own" is the checked-in `ion.config.json` block record plus the (freely editable) schema the block created.
- Keeping the catalog out of core is the load-bearing architectural choice — it preserves a clean acyclic package graph and lets third-party/self-hosted registries work by URL with no code change.
- Enforcing the dependency graph on the server (not just the CLI) means the invariant holds regardless of how a manifest arrives (CLI, admin console, or direct API).
**Incidental fix:** the DDL executor previously emitted `DEFAULT <value>` via `sql.raw`, so a literal default like an enum's `lead` became a column reference ("cannot use column reference in DEFAULT expression"). Extracted `renderDefaultExpression` now quotes literals while passing SQL expressions (`NOW()`, `gen_random_uuid()`, keywords, numbers, casts) through — fixing both the block path and any admin-set literal default.
**Consequences:**
- Blocks are applied to a **running** instance over HTTP; there is no offline "compile a project" step. Installing into a fresh DB means booting the server first (`ion-drive dev`).
- Uninstall drops precisely the objects a block created (reverse order for FK dependents) and the tasks it declared; it does **not** remove roles it seeded (they may be in use) — those are reported and left.
- Field/record-level ownership tracking is coarse: the ledger records created *objects*, not individual seed rows, so uninstall drops whole tables (guarded by `dropData`) rather than un-seeding.
- `packages/cli` and `packages/blocks` now ship real test files, so `pnpm test` at the root no longer fails on those two for "No test files found" (`packages/admin` still has none).

---

## ADR-014: Phase 7 — Query language (operators + full-text search) and a zero-dependency client SDK

**Status:** Accepted
**Date:** 2026-07-05
**Context:** Phase 7 (polish/launch prep) had two substantive pieces of product work beyond docs: (a) make the list query surface expressive enough for real applications — the requirement was paged searching via *both* a free-text term *and* per-property operators like `name[NEQ]=John&date[GT]=10-10-20` — and (b) give the "bootstrap a project" story a concrete on-ramp: helper libraries that build those queries. The filter engine already existed (`field[op]=value`, lowercase canonical operators); it needed aliasing/search, and there was no client library.
**Decision — query language (`data/`):**
- **Operators are case-insensitive and aliased.** The parser normalises `[NEQ]`/`[neq]`/`[ne]`/`[!=]`/`[<>]` → `neq`, `[>]`→`gt`, `[contains]`→`ilike`, `[notin]`→`nin`, etc., through a single alias table shared (by copy, not import) with the client builder. A bare `field=value` still implies `eq`. This lets consumers write natural URLs without memorising canonical names — the user's `name[NEQ]=John&date[GT]=...` works verbatim.
- **Free-text `search` (alias `q`).** `QueryOptions` gains `search?: string`. `DataService` applies it as an `OR` of `ILIKE '%term%'` across the object's **text-like columns** (column-type categories `text` and `enum`), AND-ed with the structured filters. `%`/`_` in the term are escaped so a term is matched literally, not as a pattern.
- **Filters + search are applied through one shared `applyConditions` helper** used by *both* the data query and the count query, so `totalCount` (and therefore pagination) always reflects the search — fixing a latent asymmetry where the previous code applied filters to each query via duplicated loops.
- Reflected consistently across all surfaces: REST (`?search=`/`?q=` + operators), GraphQL (a `search: String` arg on every generated list query), MCP (`search` on `query_data`), and the OpenAPI list parameters.
**Decision — client SDK (`packages/client` = `@ionshift/ion-drive-client`):** A new **zero-runtime-dependency** package (uses the global `fetch`; runs in Node and the browser), designed after **Supabase's postgrest-js** fluent ergonomics (researched alongside Firestore's modular API), with two layers:
- A pure `QueryBuilder` that emits exactly the server's query string via `URLSearchParams`, normalising aliases and encoding values (dates → ISO). Filter/modifier surface mirrors Supabase names: `.eq/.neq/.gt/.gte/.lt/.lte/.like/.ilike/.in/.nin/.is/.not/.match/.search/.order/.sort/.limit/.offset/.range/.page/.pageSize/.expand/.select`. Exposed standalone via a `query()` factory for callers who only want the string.
- An `IonDriveClient` fetch wrapper whose `from(object)` returns a `Resource<T>`: `.select(cols?)`/`.query()` begin a read; `.insert` (single→row, array→bulk), `.update(id)`, `.delete(id)`, `.get(id)`, `.bulkDelete` cover writes. Reads run through a bound `ResourceQuery` (a `QueryBuilder` subclass) that is **thenable** — `await`-ing the chain executes the list (Supabase's signature ergonomic, chosen by the user over an explicit terminal), with `.list()/.all()/.first()/.single()/.maybeSingle()` for explicit/single-row shapes. Envelopes are unwrapped, 404s map to `null`/`false`, and everything else **throws** a typed `IonDriveError` (chosen over Supabase's `{ data, error }` for consistency with the codebase's throwing error model).
- **Pagination:** the server gained `limit`/`offset` params (alongside `page`/`pageSize`; offset-based wins and the reported page/pageSize are derived) so the SDK can offer Supabase's `.limit(n)`/`.range(from,to)` faithfully. Reflected on REST/GraphQL/MCP/OpenAPI.
**Rationale:**
- **Types re-declared, not imported from core.** The client duplicates the small wire types (and the operator alias table) rather than depending on `@ionshift/ion-drive-core`, keeping it dependency-free and browser-safe — the same reasoning as keeping the block catalog out of core (ADR-013). The cost is a tiny amount of duplication guarded by the shared shape of the REST contract.
- **A subclass for the bound query** (rather than composition) lets `.select(...).search(...)` stay fully chainable with correct typing (builder methods return `this`) and lets the same object be `await`-ed; the thenable `then` is an intentional `PromiseLike` (biome `noThenProperty` suppressed with a comment).
- The SDK is the "helper lib that builds these" the bootstrap use case needs; `ion-drive init` now scaffolds a starter (`ion/client.ts` + a paged-search `example.ts`) that wires it up, closing the loop from "server is up" to "my app queries it".
**Consequences:**
- The package graph gains `client` as a **leaf** (`core → blocks → cli`; `client` depends on nothing internal), so no cycle risk. The production Dockerfile's builder stage now copies every workspace manifest (`blocks`, `client`) so `--frozen-lockfile` resolves.
- Operator aliasing is intentionally permissive (symbols like `>`/`<>` accepted); unknown operators are still dropped (REST) or rejected (builder throws), so it fails safe.
- Search is `ILIKE`-based (no trigram/tsvector index yet); fine for moderate datasets. A GIN/pg_trgm-backed mode can be added behind the same `search` option later without an API change.
- `in`/`nin` list values are now coerced per-item (so `age[in]=18,21` compares numerically), a slight behaviour change from the previous string-only split — matches the single-value coercion already in place.

---

## ADR-015: Phase 9 — Extensibility core (service registry + plugins), a transactional-outbox message bus, and CRUD events

**Status:** Accepted
**Date:** 2026-07-05
**Context:** The core is wired by manual construction in one `createServer()` function, with exactly one real port/adapter seam (`AuthProvider`, ADR-010) whose implementation is nonetheless hard-coded. There is no message bus, event emitter, DI/registry, or plugin loader anywhere in `packages/core/src`, and records carry no change-event stream or audit trail. Phase 9 makes the platform extensible **without forking core**: out-of-repo plugins must be able to seamlessly *replace* infrastructure implementations (cache, email, message bus) the way a Spring Boot autoconfiguration or an Express plugin does, and events must flow through the system with loose coupling so plugins and building blocks cooperate without hard dependencies. The concrete adapters (Redis, SendGrid, RabbitMQ) are deliberately out-of-repo; this phase builds the *seams* plus in-core defaults and proves them with one reference override and an audit consumer.
**Decision — service registry & plugin host (`runtime/`):** A **lightweight in-house `ServiceRegistry`** (token-keyed singleton container, last-write-wins) plus a `definePlugin({ name, setup(ctx), onReady?, onShutdown? })` host and a `loadPlugins()` loader (programmatic `plugins: IonPlugin[]` on `createServer` + `ION_PLUGINS` module specifiers via dynamic `import()`). Plugins run their `setup` **after core registers defaults but before dependent services are built**, so a plugin's `registry.set('cache', new RedisCache())` transparently replaces the default. No awilix/inversify/tsyringe — this matches the manual-injection, dependency-light ethos (croner-over-BullMQ, ADR-012) and extends the existing `AuthProvider` port precedent rather than introducing a second wiring paradigm.
**Decision — provider ports + in-core defaults:** Each swappable capability is a small interface (port) with an in-core default (adapter) registered under a token: `CacheProvider`/`MemoryCache`, `EmailProvider`/`LogEmailProvider`, `MessageBus`/`OutboxBus`, and a thin `LoggerProvider` token over the **existing** pino+OTel logger (no behaviour change; just makes the sink swappable). External plugins override by token.
**Decision — message bus (`messaging/`): a Postgres transactional outbox with named consumer groups.**
- The default bus is **durable, not in-memory.** `publish(event, trx)` inserts into an `_ion_events` outbox table **inside the caller's CRUD transaction** — no dual-write gap. An in-process `EventDispatcher` relays committed events to subscribers; a Redis Streams adapter can later relay from the same outbox.
- **Delivery is at-most-once per named consumer group.** Each subscription declares a `consumer` name (= group). The dispatcher claims each `(event, consumer_group)` pair via `INSERT … ON CONFLICT DO NOTHING` / `SELECT … FOR UPDATE SKIP LOCKED` against an `_ion_event_deliveries` table, so with multiple app instances on the same Postgres exactly one instance processes a given event for a given consumer — the DB-backed equivalent of a Redis Streams consumer group, **requiring no broker**. Delivery is at-least-once + idempotent on `event.id` (redelivery on handler failure is safe).
- A `perInstance` flag unifies the two delivery modes the user described: default (shared group) = once cluster-wide (side effects: emails, audit, state changes); `perInstance: true` suffixes the group with an instance id = once *per instance* (cache invalidation, in-memory projections). One mechanism, one toggle.
- Topics use a dotted scheme `data.<object>.<created|updated|deleted>`; subscriptions match exact, prefix, or `*`-wildcard segments (so a consumer can grab `data.*` or `data.contacts.*`). Built-in handlers `log_event` and `persist_event` mirror the built-in task handlers; `persist_event` writes an event envelope into a configured data object via `DataService`, keeping core content-agnostic.
**Decision — CRUD events from `DataService`:** `create`/`update`/`delete`/`bulk*` are wrapped in a transaction and emit `data.<object>.<op>` with payload `{ object, id, op, before, after, diff }`. `update` reads the before-image in-txn; `delete`/`bulkDelete` switch to `… RETURNING` so the removed row rides the event; `bulkCreate` switches `returning('id')`→`returningAll()` for per-row `created` events. The **diff excludes system-managed columns** (`created_at`/`updated_at`, and future `*_by`) via a shared `SYSTEM_MANAGED_COLUMNS` set. The bus is injected optionally; when absent every emit is a **no-op**, matching the telemetry `record*` convention. `created_by`/`updated_by` and actor-identity threading are **deferred** — the payload carries no `actorId` this phase (a `changed_by` column is stubbed on the audit object for forward-compat).
**Decision — blocks declare subscriptions; audit ships as a building block:** `blockManifestSchema` gains a `subscriptions` array (`{ event, consumer, handler, mode?, perInstance?, config? }`); the installer adds a 6th ordered step (`applySubscriptions`) and `BlockEngine.initialize()` re-registers each installed block's subscriptions from the `_ion_blocks` manifest snapshot at boot (durable *state* in the DB; handler *code* resolved from the bus registry). Handlers are validated to exist at install time (like task types). The official `@ionshift/ion-drive-blocks` catalog gains an **`audit`** block: an `audit_log` object + one `data.*` subscription with consumer `audit` handled by the built-in `persist_event` — a single consumer group ⇒ exactly one audit row per change, even across instances. This proves both the block-declared-subscription path and the at-most-once guarantee, in-repo and testable.
**Rationale:**
- **In-house registry over awilix:** the codebase already injects via constructor options-bags (`BlockEngineServices`, `TaskEngineOptions`) and deliberately avoids heavy deps; a ~one-file token container gets the swap semantics without a new paradigm or dependency.
- **Transactional outbox over in-memory emitter:** the audit/side-effect use cases need durability and no dual-write gap, and the outbox + `SKIP LOCKED` deliveries model gives correct multi-instance fan-out **without Redis**, then maps 1:1 onto Redis Streams when the plugin is added — same reasoning ADR-012 used to keep a broker optional.
- **Named consumer groups + `perInstance`** directly express the user's "broadcast to N consumer types, once each, even with M instances" while still allowing genuine per-instance in-process events, with one primitive.
- **Diff excludes system columns** by construction (shared exclusion set), satisfying "the diff must never contain updatedAt/updatedBy".
- **Content-agnostic core:** the generic `persist_event` handler keeps audit logic in a catalog block, not core — the same boundary as the block engine bundling no catalog (ADR-013).
**Consequences:**
- The outbox table must be **co-located with the data tables** (same database) for the publish to be atomic with the CRUD write. Today `systemDb`/`tenantDb` share one connection string, so `_ion_events`/`_ion_event_deliveries` live in the tenant DB; under future true database-per-tenant the outbox lives per-tenant DB (noted, not yet exercised).
- `DataService` write methods now open transactions and, for update/delete, do an extra read/`RETURNING` — a small cost paid only when the bus is enabled, and it makes before/after diffs available platform-wide.
- The default dispatcher is in-process (nudged after commit + short poll fallback); cross-datacenter/low-latency fan-out is the Redis adapter's job, added later behind the same `MessageBus` port with no core change.
- New system tables (`_ion_events`, `_ion_event_deliveries`) and config flags (`ION_PLUGINS`, `ION_EVENTS_ENABLED`, dispatcher interval) follow the existing `_ion_*` + `envBoolean`/`ION_*` conventions.
- Out of scope / follow-ups: external plugin repos (`@ion-drive/plugin-redis`, `plugin-sendgrid`, `plugin-rabbitmq`), the Redis Streams adapter, and `created_by`/`updated_by` + actor threading through DataService and the REST/GraphQL/MCP surfaces.

## ADR-016: Phase 8 — Admin console UX overhaul (design system, Airtable-grade grid, in-process observability surface)

**Status:** Accepted (2026-07-05)
**Context:** The Phase 3 admin console was functional but utilitarian: a 206-line `ui.tsx`, a plain-`<table>` DataGrid, `confirm()`/inline-error UX, an empty header, and no observability pages. Phase 8 (see `docs/phase_8_implementation_plan.md`) rebuilds it into a production-grade product surface — the first thing an evaluating developer sees.
**Decision — real design system, one component per file:** `ui.tsx` is split into `components/ui/` (26 primitives + barrel), each with top-of-file JSDoc, `forwardRef`, `displayName`, cva variants, and a co-located test where behavior warrants it. New primitives wrap **Radix** headless packages (dialog, tabs, dropdown/context menu, popover, tooltip, switch, checkbox, scroll-area, separator) — accessibility (focus trap, ARIA, keyboard) comes from Radix, styling from our tokens. `index.css` grows a space-themed accent palette (`--ion-blue/purple/cyan/green/amber/red`), semantic status tokens, surface layers, motion tokens/keyframes with a `prefers-reduced-motion` collapse, and a validated chart palette (below), all wired through Tailwind v4 `@theme inline`.
**Decision — DataGrid is server-driven TanStack Table + virtualizer:** the grid keeps *all* querying on the server via the Phase 7 REST syntax (`q=`, `field[op]=`, `sort=-f`, `page/pageSize`) — TanStack Table provides only the row/selection model, `@tanstack/react-virtual` renders visible rows. Inline editing is optimistic single-field PATCH with rollback+toast; layout prefs (column visibility/widths) persist per-object in a zustand+localStorage store; keyboard nav is roving-focus (arrows/Enter/Escape/Tab/Space/Delete). The RecordSheet (Radix-dialog Sheet + react-hook-form + zod schema derived from field definitions) is the expanded-record editor.
**Decision — "instant observability" is in-process, not a stack:** a `LogBuffer` ring (pino multistream arm, `ION_LOG_BUFFER_SIZE`) backs `GET /api/v1/logs` + an SSE `/logs/stream`; a `TrafficStats` minute-bucket ring (fed by the existing request-tracing hook) backs `/api/v1/stats`, `/stats/traffic`, `/stats/errors`; `/api/v1/version` reports version/uptime/feature flags. Both are ephemeral per-process by design — Prometheus/OTLP remain the durable path (ADR-012). New RBAC resources `logs`/`stats` guard them.
**Decision — dataviz discipline for charts:** recharts wrappers live in `components/charts/`; series colors are a **validated** categorical palette (six-checks validator, separate light/dark steps) bound to the *entity* (surface), never rank; percentile bars are single-hue with direct labels; a legend always accompanies multi-series charts.
**Decision — performance budget enforced by code-splitting:** recharts, the ObjectDetail+DataGrid bundle, the RecordSheet (react-hook-form+zod), and all secondary pages are `React.lazy` chunks behind the AppShell's Suspense boundary; initial bundle is ~184KB gzipped (<200KB budget).
**Consequences:**
- All `alert()`/`confirm()` are gone (sonner toasts + `AlertDialog` with type-to-confirm for destructive ops); every icon button has an `aria-label`; raw checkboxes/selects are replaced by styled primitives.
- New pages: Tasks (+detail with run history/Run Now), Building Blocks, Logs, Metrics, API Keys (split from Settings); sidebar is grouped (OVERVIEW/DATA/ACCESS/OBSERVE) with collapse mode and a live health/version footer; ⌘K command palette (cmdk) is global.
- The admin package finally ships tests (vitest + jsdom + Testing Library), so the root `pnpm test` failure noted since Phase 3 is resolved.
- Incidental fix: the API client only sends `content-type: application/json` when a body exists (Fastify rejects empty JSON bodies, which broke body-less POSTs like `/tasks/:id/run`).
- Deferred: drag-to-reorder schema fields, column pinning, global record search in the palette, log export button, `vitest-axe` automated a11y assertions.

## ADR-017: Backend-platform positioning; metadata layer retained under three governance rules (Phase 10)

**Status:** Accepted (2026-07-05)
**Context:** A review of the schema editor surfaced that the field metadata layer is half-built: `FieldConstraints` (min/max/pattern/enumValues) is defined and persisted in `_ion_fields` but enforced nowhere; `modify_field`/`rename_field` change types are declared but unimplemented in `SchemaManager`; fields have no description or UI metadata; the admin designer exposes only name/type/three flags. That raised a foundational question: should Ion Drive keep a metadata layer over the physical schema at all (Directus-style), or go "pure SQL" where the Postgres catalog is the only source of truth (Supabase-style)? And underneath that, a positioning question: application backend platform vs. headless CMS. Research findings: Supabase's purity does **not** eliminate sync pain — schema drift between dashboard edits, migration files, and environments is one of their most-documented problems, and purity costs them all presentation metadata; Directus's pain concentrates where **structural** facts are duplicated in metadata and where config has no Git story, but their "unmanaged collections" introspection model degrades gracefully; PocketBase best resolves the runtime-vs-code tension by auto-generating committed migration files from every UI/API change. Our own competitive research named "schema-as-code vs schema-at-runtime" pain #1 and already promised schema export — never built.
**Decision — positioning: application backend platform, not headless CMS.** Apps (via the client SDK/REST/GraphQL/MCP) are the primary readers and writers; the admin console is for visibility, schema/block management, and metrics — it is not a content-editor product. Consequences: no Directus-grade interface/display configurator, no editor-persona features; field UI metadata stays deliberately thin (description, order, control hint, enum choices). The moat is the combination of managed data layer + owned-code building blocks + built-in observability + agent legibility — not MCP alone (table stakes by 2026) and not content editing.
**Decision — the metadata layer stays.** Dropping it is not actually available: building blocks are manifests applied through the managed layer with a ledger; validated preview-before-apply is the layer; MCP/OpenAPI value derives from friendly typed objects. A pure-SQL Ion Drive collapses into PostgREST-with-extra-steps. Apps never issue DDL, so the only bypass actor is a developer with `psql` — a narrow surface addressed below rather than ignored.
**Decision — three governance rules that keep the layer honest:**
1. **Anything Postgres can enforce lives in Postgres; metadata only mirrors it.** Types, nullability, unique, FKs already do. Field constraints (min/max/pattern/enum values) become real `CHECK` constraints generated by the DDL executor. Metadata can then at worst be *stale*, never *lie* about what the database will accept — even manual SQL writes cannot violate field rules.
2. **Anything that exists only in metadata must be presentation-only** (display name, description, sort order, UI control hint, enum choice colors). The database has no opinion on these, so they cannot drift. App-level-only validation is minimized to ~zero by rule 1.
3. **Drift is expected and made boring, not forbidden.** Two features: (a) **schema export/sync** — PocketBase-style; every managed change already lands in `_ion_migrations`, add snapshot export/import + CLI `schema pull/diff/push` for Git versioning and environment promotion; (b) a **reconcile/doctor** — diff `information_schema` against `_ion_fields`/`_ion_objects`, report unmanaged tables/columns Directus-style with an "adopt" action instead of erroring. The managed path remains the only *supported* write path.
**Decision — schema provenance & protection (`managedBy`), field-level not object-level:** every object and field records a provenance source — `user`, `block:<name>`, or `system` (distinct from `isSystem`, which stays platform-internal). Block-declared fields are **contract-protected**: structural changes (delete, rename, type change, constraint loosening) through the schema API are rejected with an error naming the owning block, overridable via `?force=true` (admin), mirroring install-force semantics. Presentation-only edits (displayName, description, `uiOptions`, `isIndexed`) remain allowed — the same rule-2 split. Block-owned **objects** are *not* locked: users may add their own fields alongside block fields (the shadcn customization story); object deletion continues to route through the Phase 6 uninstall guards. A whole-object boolean lock was rejected because it forbids the customization the block model exists to enable, and a bare boolean was rejected because enforcement errors, uninstall cleanup, and the drift doctor all need the *who*. Scope of protection is the platform's own API surface (admin/REST/MCP agents — notably preventing an LLM agent from restructuring a block's contract); raw SQL bypass remains the drift doctor's job, which uses provenance to escalate severity for drift on block-owned tables. Postgres event-trigger DDL blocking was considered and rejected as too heavy for a self-hosted dev tool.
**Decision — Phase 10 scope ("Schema Designer Maturity"), re-weighted by the above:** engine-level field modification (compatible-type matrix, flag toggles with data-safety checks, required-needs-backfill-default, rename) surfaced through preview; DB-backed constraint enforcement reflected across REST/GraphQL/MCP/OpenAPI and admin forms; thin field metadata (`description`, `uiOptions`); a field-designer overhaul (grouped type picker showing the PG type and size limits, type-aware default/constraint inputs, enum choices editor); **relation pseudo-field** — picking "Link to record" (single/multiple) on a field auto-creates the FK column + relationship and lights up linked-record editors/expansion in the grid and record sheet; schema export + drift doctor.
**Consequences:**
- `CHECK` constraint generation makes `modify_field` responsible for constraint add/drop/alter DDL, and the change validator must check existing data before tightening (as it must for unique/required).
- The `/column-types` endpoint returns full `COLUMN_TYPES` info (pg type, category, label) so the UI can stop being opaque about `text` vs `short_text` limits.
- Enum values move from advisory metadata to DB-enforced; existing enum columns created before Phase 10 need a backfill migration path (validate-then-add-constraint, surfaced in preview).
- Deliberately rejected: interface/display configurator, layout/appearance metadata beyond the thin set, content-editor workflows (drafts, locales, publishing) — CMS-market features that dilute the backend-platform mission.

**Implementation notes (2026-07-06, Phase 10 shipped):** everything above landed as designed; noteworthy deltas discovered during implementation —
- **Relationship names are per-source-object**, not global: the crm block legitimately declares two `company` relationships (contacts→companies, deals→companies). The validator's new duplicate check and the registry's dedupe key on `(name, sourceObjectName)`, and `addRelationship` gained validation for duplicate names and FK-column collisions (previously a raw PG error).
- **`addRelationship` now re-hydrates both endpoint objects** into the registry. Before, the new relationship and its FK field were invisible to `getObject()` until restart — which silently broke expand, snapshot export, and the admin designer. Junction table/columns are now also recorded in `_ion_relationships` (they were always null).
- **`expand=` was parsed but never applied** by `DataService`; Phase 10's linked-record work implemented it for real (batched FK-side hydration + many_to_many via the junction) rather than treating it as existing per the plan's assumption.
- **Adopted tables may lack `created_at`**, so the default list sort falls back to the primary key.
- The backfill/default expression heuristic (`renderDefaultExpression`) treats values ending in `)` as SQL expressions — a value like `(none)` becomes an expression. Documented quirk, inherited from the Phase 6 default-rendering rules.

## ADR-018: Framework-first distribution — user-owned composition root, vendored-logic blocks, sealed infra plugins

**Status:** Accepted (2026-07-06)
**Context:** Two related questions surfaced while planning the extension story. (1) Are infrastructure adapters (Redis cache/bus, OTLP exporters, SendGrid, RabbitMQ) plugins or blocks? (2) How do blocks that need business logic work — e.g. `invoicing` talking to Stripe and exposing its own endpoints? Blocks today (ADR-013) are declarative manifests applied server-side; they cannot carry code, and letting a runtime-installable artifact ship code would break the trust boundary that makes blocks safe to install through a REST endpoint. Meanwhile the product's end goal is fixed: **build business software at super speed, without reinventing the wheel and without sacrificing the ability to customize and override.** The original distribution assumption (clone the monorepo, or run a container and talk to it over HTTP) leaves that customization promise with no home — there is no user-owned code tree for block logic to land in.
**Decision — the litmus test:** *if it changes **how** the platform runs (transport, storage, telemetry, delivery), it is a **plugin**; if it changes **what domain data/behavior** the platform manages (CRM, invoicing, audit), it is a **block**.* Infra adapters are sealed npm packages that override registry tokens (`CACHE_SERVICE`, `MESSAGE_BUS`, `LOGGER_SERVICE`, …) via the ADR-015 plugin host — team-managed, operator-installed at deploy time, never user-edited.
**Decision — framework mode is the primary distribution model.** The canonical user journey: create a blank repo → `ion-drive init` scaffolds a complete project — a `package.json` depending on the published `@ionshift/ion-drive-core` (+ admin), a thin `server.ts` composition root calling the already-public `createServer(config, { plugins })` and loading `/blocks/*`, `.env`, a Postgres compose file, the client starter, and agent instructions (roadmap Part 3.2) → `pnpm dev` boots the whole backend **and the admin console**, batteries included. The standalone container image remains as the secondary zero-code mode. Users never clone `ionshift/ion-drive`; the monorepo becomes the upstream, as `shadcn-ui/ui` is to its users.
**Decision — blocks with logic vendor their code, shadcn-style.** `ion-drive add <block>` becomes a two-part operation: the manifest is still applied through the server APIs (ledger, `managedBy` stamping, uninstall guards all unchanged), and the block's business-logic source (handlers, actions, webhook verifiers) is copied into `/blocks/<name>` in the user's tree. From that moment the code is the user's: edit freely, no version treadmill; updates arrive later via `ion-drive diff` (catalog vs. vendored, user-driven merge, never auto-overwrite). Uninstall drops the schema; deleting the folder is the user's move (the CLI says so). `managedBy: block:<name>` protection continues to apply to the *schema* a block created, never to vendored code.
**Decision — manifests declare, code provides.** The existing seam (subscriptions and tasks reference handlers by *name*) extends: manifests gain `actions` (name, input schema, RBAC) and `requires` (handler names / plugin capabilities); vendored code registers those names through the plugin host at boot; the installer validates every referenced handler is registered and fails with an actionable error otherwise. Block actions are served by a parameterized catch-all (`POST /api/v1/blocks/:block/actions/:action` — the same trick that makes `data-routes` dynamic under Fastify's no-routes-after-listen constraint), with a webhook sibling (`/api/v1/hooks/:block/:hook`, session-auth-exempt, handler-verified signatures), and are reflected into OpenAPI and MCP per the surface-parity convention.
**Decision — core serves the built admin SPA** as static assets (the prerequisite for the one-command batteries-included story). Monorepo development of the admin keeps the Vite dev-server + proxy path.
**Rejected:** growing the built-in generic handlers (`http_request` + templating/conditionals) into a low-code logic engine — a Turing tarpit that fights the backend-developer positioning; sandboxed runtime-uploaded scripts (V8 isolates / workers) — a possible far-future "functions" phase, not the block model; auto-overwriting vendored code on update.
**Consequences:**
- Publishing (npm for core/admin/cli/client/blocks, Docker image, changesets) is promoted from "launch readiness" to a hard prerequisite (roadmap F23 → Phase 14 Tier 0).
- `packages/blocks` carries vendorable source alongside manifests; the emit/drift-guard pattern extends to code templates.
- The upgrade axis splits cleanly: engine/admin/plugins are npm dependencies (`pnpm up` gets fixes without touching user code); blocks are owned code (diff-in updates). Nothing ever forces a merge between a framework upgrade and user business logic — this is the core differentiation ("Supabase's instant APIs, Payload's code-first ownership, shadcn's take-the-code distribution").
- `ion-drive dev` becomes "run the user's `server.ts` under tsx watch"; hot-reloading block code next to runtime schema changes is a first-class DX loop, not tooling glue.
- Vendored scaffolds must stay **thin** — express business decisions by calling `DataService`/`TaskEngine`/`SecretsManager`; never re-implement plumbing. Heavy comments; LLM legibility is a product goal.
- Docs re-center on `init` as the first-run story; the monorepo quick start remains for contributors.

Implementation plan: `docs/phase_14_implementation_plan.md`.

**Amendment (2026-07-06) — blocks live in their own repos.** Each block gets its own repository (`ionshift/block-<name>`) containing its manifest source, `code/` templates, README, and CI (manifest validate + emit drift + install smoke against a core container). Distribution is a minimal **registry index** (JSON: name → versions → artifact URL) that the CLI resolves from, alongside direct URLs and **local paths** (`ion-drive add ../block-crm` — which is also the test loop for developing blocks against a working copy of core). Official blocks ride the exact same path as third-party blocks — dogfooding the ecosystem story. Consequences: `packages/blocks` is retired during Phase 14 (the `cli → blocks` workspace dependency dissolves; block repos depend on the *published* core package for manifest types — one more reason Tier 0 publishing is a hard prerequisite); blocks version independently of the platform release train (which the fixed-version policy would otherwise have made awkward); the block-authoring toolchain (`ion-drive block new/validate`, F22) is promoted from ride-along to a required Phase 14 deliverable. Trade-off accepted: N repos means N CI setups before launch; a single separate blocks monorepo was considered and declined in favor of full third-party parity. A full marketplace (search, ratings, web UI) stays out of scope — the index is a flat JSON file.

**Re-amendment (2026-07-06, executed) — one `ionshift/blocks` repo instead of repo-per-block.** Owner decision during Tier 4 execution: the official blocks are extracted into a **single separate repository** (`ionshift/blocks`) with one directory per block (`crm/`, `invoicing/`, `communications/`, `audit/` — each `block.json` + optional `code/` + `dist/block.json` artifact) and the **registry index in the same repo** (`registry/index.json`). Everything else in the amendment stands: same registry → artifact-URL → `ion-drive add` pipeline, direct-URL and local-path resolution unchanged, `packages/blocks` still retired, `ion-drive block new/validate/pack` still the authoring toolchain (a third-party author's standalone repo has the identical per-block layout). Rationale: pre-launch, N repos means N CI setups and no atomicity when the manifest schema moves (Phase 14 itself added `actions`/`hooks`/`requires` to all manifests at once); the single repo keeps one CI and one clone while still exercising the exact external distribution route — the registry indirection makes a later split into per-block repos cheap if any block ever needs an independent release cadence. What is knowingly given up: per-block version independence (acceptable — blocks currently move together) and a byte-identical repo shape to third parties (the *per-directory* layout is identical, which is what the toolchain validates).
