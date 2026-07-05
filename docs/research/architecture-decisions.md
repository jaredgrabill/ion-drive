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
