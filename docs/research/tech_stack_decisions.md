# Ion Drive — Technology Stack Decisions

## Overview

This document captures technology choices and their rationale. Every decision is evaluated against Ion Drive's core requirements: **runtime dynamic schema**, **LLM/MCP-native**, **self-hosted-first**, and **developer QoL**.

---

## Backend Framework: **Fastify**

### Why Fastify over NestJS

| Factor | Fastify | NestJS | Hono |
|:---|:---:|:---:|:---:|
| Performance | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Boilerplate | Low | High | Very Low |
| Plugin System | Excellent | Modules (heavy) | Minimal |
| Dynamic Route Registration | ✅ Native | ⚠️ Possible | ⚠️ Limited |
| TypeScript Support | ✅ First-class | ✅ First-class | ✅ First-class |
| Community / Maturity | Large, stable | Largest, enterprise | Growing, newer |
| Schema Validation (built-in) | ✅ JSON Schema / TypeBox | Via class-validator | Via Zod |
| Multi-runtime | Node.js | Node.js | Node, Bun, Deno, Edge |

**Decision: Fastify**

**Rationale:**
1. **Dynamic route registration is critical** — Ion Drive must register and de-register API routes at runtime as data objects are created/modified. Fastify's plugin system handles this natively. NestJS's module system makes this harder; Hono's routing tree is optimized for static compilation.
2. **Performance** — Fastify is consistently among the fastest Node.js frameworks. For a platform that generates APIs for potentially thousands of data objects, this matters.
3. **Low boilerplate** — NestJS requires controller + service + module + DTO for every entity. For a platform generating these dynamically, the abstraction overhead is unnecessary. We'd be generating NestJS boilerplate to generate our boilerplate.
4. **Plugin encapsulation** — Fastify's encapsulation model is perfect for multi-tenancy. Each tenant context can be an encapsulated plugin scope.
5. **JSON Schema native** — Fastify uses JSON Schema for request/response validation, which maps directly to OpenAPI spec generation. No extra translation layer needed.

**Why not Hono:** Hono excels at edge/serverless, but Ion Drive is a stateful platform (PostgreSQL connections, schema state, WebSocket connections). Hono's strengths don't align with our deployment model. Also newer ecosystem means fewer battle-tested plugins.

**Why not NestJS:** Too opinionated and heavy for our needs. The decorator-based DI system adds complexity without benefit when our routes are generated dynamically at runtime, not defined statically in code. It would fight us at every turn.

> [!TIP]
> We can use Fastify's plugin system to build our own lightweight module system that's tailored for dynamic registration. Think: each data object definition becomes a Fastify plugin that registers its CRUD routes, validation schemas, and hooks.

---

## Database Layer: **Kysely + Raw SQL for DDL**

### Why Kysely

| Factor | Kysely | Drizzle | Prisma | TypeORM |
|:---|:---:|:---:|:---:|:---:|
| Dynamic Schema Support | ✅ Best | ⚠️ Workarounds | ❌ Static .prisma | ❌ Static entities |
| Raw SQL Access | ✅ Native | ✅ Good | ⚠️ Limited | ⚠️ QueryBuilder |
| Type Safety | ✅ Excellent | ✅ Excellent | ✅ Generated | ✅ Decorators |
| Runtime `search_path` | ✅ Easy | ⚠️ Manual | ❌ Connection string | ❌ Multiple pools |
| Schema Builder API | ✅ Yes | ⚠️ Limited | ❌ No | ⚠️ Via migrations |
| Performance | ✅ Minimal overhead | ✅ Good | ⚠️ Engine overhead | ⚠️ Heavy |
| Bundle Size | Small | Small | Large (engine binary) | Large |

**Decision: Kysely as the query builder**

**Rationale:**
1. **Dynamic schema is our core feature** — Kysely doesn't rely on static schema files or generated code. We can type queries dynamically using runtime-constructed type information.
2. **Schema Builder API** — Kysely has a built-in schema builder that can `CREATE TABLE`, `ALTER TABLE`, `ADD COLUMN`, etc. programmatically. Perfect for our runtime schema operations.
3. **`search_path` for multi-tenancy** — We can switch PostgreSQL schemas per-request with a simple `SET search_path TO tenant_schema`. Kysely handles this cleanly.
4. **Raw SQL escape hatch** — For complex DDL operations, we can drop to `sql` template tags with proper identifier escaping (`sql.table()`, `sql.ref()`).
5. **No magic** — Kysely is transparent. LLM agents can read and understand Kysely code trivially. No hidden query transformations.

### Architecture: Two-Layer Data Access

```
┌──────────────────────────────────────────────┐
│                Ion Drive Core                 │
├──────────────────────────────────────────────┤
│  Schema Manager (DDL)                         │
│  ├── Uses Kysely Schema Builder + Raw SQL     │
│  ├── CREATE/ALTER/DROP TABLE at runtime       │
│  ├── Validation engine (preview changes)      │
│  └── Migration history tracking               │
├──────────────────────────────────────────────┤
│  Data Access Layer (DML)                      │
│  ├── Uses Kysely Query Builder                │
│  ├── Dynamic CRUD based on runtime schema     │
│  ├── Relationship resolution (JOINs)          │
│  └── Pagination, filtering, sorting           │
├──────────────────────────────────────────────┤
│  Connection Manager                           │
│  ├── Per-tenant connection pools              │
│  ├── search_path management                   │
│  └── Pool health monitoring                   │
└──────────────────────────────────────────────┘
```

> [!IMPORTANT]
> We will NOT use Kysely's compile-time type system for tenant data objects (since those are defined at runtime). Instead, we'll build a **runtime type registry** that validates queries against the current schema definition. Kysely will be typed as `Kysely<any>` for tenant data operations, with our own validation layer on top. Kysely's type system WILL be used for Ion Drive's own internal/system tables (schema metadata, users, audit logs, etc.).

---

## Authentication: **Better Auth** (Primary) with WorkOS Adapter

### Decision Matrix

| Factor | Better Auth | WorkOS AuthKit |
|:---|:---:|:---:|
| Self-hosted ownership | ✅ Full control | ❌ Managed SaaS |
| Data in your DB | ✅ | ❌ |
| Enterprise SSO (SAML) | ⚠️ Plugin | ✅ Built-in |
| Cost | Free | Free tier, then paid |
| TypeScript native | ✅ | ✅ SDK |
| Multi-tenancy | ✅ Plugin | ✅ Organizations |
| Vendor lock-in risk | None | Moderate |

**Decision: Better Auth as the default, with a pluggable auth adapter interface**

**Rationale:**
1. **Self-hosted-first** — Better Auth stores everything in your database. No external dependency. This aligns with "self-hosted Firebase" positioning.
2. **Full control** — Ion Drive users own their auth data, session logic, and can customize flows.
3. **No per-user fees** — Critical for an open-source platform where users might have thousands of end-users.
4. **Adapter pattern** — We define an `AuthProvider` interface. Better Auth is the default implementation. WorkOS, Auth0, Clerk can be swapped in via configuration for users who want managed enterprise SSO.

```typescript
// Auth adapter interface (conceptual)
interface AuthProvider {
  authenticate(credentials: Credentials): Promise<Session>;
  validateSession(token: string): Promise<User | null>;
  createUser(data: CreateUserInput): Promise<User>;
  assignRole(userId: string, role: string): Promise<void>;
  getPermissions(userId: string): Promise<Permission[]>;
  // ... SSO, MFA, etc. as optional capabilities
}
```

> [!NOTE]
> Better Auth's plugin system supports 2FA, passkeys, magic links, and multi-tenancy. For users who need enterprise SAML/SCIM, we document WorkOS as the recommended upgrade path but don't make it the default.

---

## Observability: **OpenTelemetry → Grafana Stack**

### Stack Composition

| Layer | Tool | Purpose |
|:---|:---|:---|
| Instrumentation | **OpenTelemetry SDK** | Instrument all Ion Drive operations |
| Collection | **OTel Collector** | Receive, process, export telemetry |
| Logs | **Grafana Loki** | Log aggregation (label-indexed, cheap) |
| Metrics | **Prometheus** | Metrics collection and alerting |
| Traces | **Grafana Tempo** | Distributed tracing |
| Visualization | **Grafana** | Unified dashboards |

**Rationale:**
1. **OpenTelemetry is vendor-neutral** — users can swap backends (Datadog, New Relic, etc.) by changing OTel Collector config
2. **Loki is cost-effective** — label-indexed (not full-text), uses cheap object storage, perfect for short TTL
3. **Grafana is the standard** — free, powerful, well-known
4. **All open source** — no licensing costs, no vendor lock-in

### Short TTL Strategy

```yaml
# Loki config for Ion Drive defaults
limits_config:
  retention_period: 168h  # 7 days default
  
compactor:
  retention_enabled: true
  retention_delete_delay: 2h
```

### What We Instrument Out of the Box
- All API requests (method, path, status, latency, tenant)
- Schema change operations (DDL audit trail)
- Authentication events
- Background task execution
- MCP tool invocations (with full audit trail)
- Database query performance
- Error rates and stack traces

### Deployment Model
Ion Drive ships a `docker-compose.observability.yml` overlay that includes Grafana, Loki, Tempo, and Prometheus pre-configured with Ion Drive dashboards. Users can opt-in during setup or bring their own observability stack via OTel Collector configuration.

> [!TIP]
> Inspired by .NET Aspire's "batteries included" approach — we ship pre-built Grafana dashboards that light up immediately. Zero configuration needed for basic observability.

---

## Admin Console: **React + Vite (SPA)**

### Why Not Next.js

| Factor | React + Vite (SPA) | Next.js |
|:---|:---:|:---:|
| Deployment simplicity | ✅ Static files | ⚠️ Needs Node.js server |
| Coupling to backend | None — pure API client | Tight (if using server components) |
| Bundle size | Controlled | Can bloat |
| SSR/SEO needed? | ❌ (admin panel) | ✅ (public sites) |
| Developer familiarity | Universal | Framework-specific |

**Decision: React 19 + Vite SPA**

**Rationale:**
1. **Admin consoles don't need SSR** — no SEO, no public crawling
2. **Static deployment** — the admin console builds to static files that can be served by Fastify itself or any CDN/nginx
3. **Decoupled from backend** — the admin console is a pure API consumer, making it possible to replace or extend independently
4. **Vite is fast** — instant HMR, fast builds
5. **React is the most LLM-friendly frontend framework** — more training data, better agent support

### Admin Console Libraries
- **UI:** shadcn/ui (React) — consistent with our "shadcn pattern" philosophy
- **State:** TanStack Query (server state) + Zustand (client state)
- **Tables:** TanStack Table — perfect for the Airtable-like data grid
- **Forms:** React Hook Form + Zod — schema-driven form generation
- **Charts:** Recharts or Tremor — for dashboard metrics
- **Router:** TanStack Router — type-safe routing

---

## Building Blocks System: **Custom Registry + CLI**

### Architecture

```
┌───────────────────────────────────────────────────────┐
│                  Building Block Registry                │
├───────────────────────────────────────────────────────┤
│  block.json (manifest)                                  │
│  ├── name, version, description                         │
│  ├── dependencies (other blocks)                        │
│  ├── data objects (schema definitions)                  │
│  ├── relationships                                      │
│  ├── scripts/ (lifecycle hooks, business logic)         │
│  ├── api/ (custom endpoint definitions)                 │
│  ├── config/ (configurable properties with defaults)    │
│  ├── seed/ (base data and defaults)                     │
│  ├── integrations/ (external API configurations)        │
│  └── tasks/ (scheduled/triggered actions)               │
└───────────────────────────────────────────────────────┘
```

### Distribution Model
1. **CLI pull** (shadcn pattern): `npx ion-drive add crm` — pulls block source into your project
2. **Registry install** (marketplace): Browse and install from a hosted registry
3. **Local blocks**: Define custom blocks in your project for reuse

### How a Block Installs
1. CLI reads `block.json` manifest
2. Validates dependencies (other blocks, minimum Ion Drive version)
3. Copies source files into the project's `blocks/` directory
4. Runs schema migrations to create required data objects
5. Registers API routes
6. Seeds default data
7. Registers scheduled tasks

> [!IMPORTANT]
> Blocks own their code. Once pulled, users can modify everything. Updates are opt-in, shown as diffs, and never auto-applied.

---

## Project Structure (Monorepo)

```
ion-drive/
├── packages/
│   ├── core/                  # Core engine (schema manager, data access, MCP)
│   │   ├── src/
│   │   │   ├── schema/        # Runtime schema management
│   │   │   ├── data/          # Dynamic CRUD operations
│   │   │   ├── api/           # REST + GraphQL generation
│   │   │   ├── mcp/           # MCP server
│   │   │   ├── auth/          # Auth adapter interface
│   │   │   ├── tasks/         # Scheduled/triggered tasks
│   │   │   ├── config/        # Configuration & secrets
│   │   │   └── telemetry/     # OTel instrumentation
│   │   └── package.json
│   ├── admin/                 # Admin console (React + Vite)
│   │   ├── src/
│   │   │   ├── components/    # UI components (shadcn/ui)
│   │   │   ├── pages/         # Admin pages
│   │   │   ├── hooks/         # Data fetching hooks
│   │   │   └── lib/           # Utilities
│   │   └── package.json
│   ├── cli/                   # CLI tool (block management, project init)
│   │   └── package.json
│   └── blocks/                # Official building blocks
│       ├── crm/
│       ├── invoicing/
│       ├── communications/
│       └── ...
├── docker/                    # Docker compositions
│   ├── docker-compose.yml     # Core (Ion Drive + PostgreSQL)
│   └── docker-compose.observability.yml  # Grafana stack overlay
├── docs/                      # Documentation
├── turbo.json                 # Turborepo config
├── pnpm-workspace.yaml
└── package.json
```

### Monorepo Tooling
- **Package Manager:** pnpm (workspaces, fast, disk efficient)
- **Build System:** Turborepo (parallel builds, caching)
- **TypeScript:** Project references for incremental builds
- **Testing:** Vitest (fast, Vite-native)
- **Linting:** Biome (fast, replaces ESLint + Prettier)
- **Git Hooks:** simple-git-hooks + lint-staged

---

## Runtime & Deployment

### Primary: Docker
```yaml
# Minimum viable deployment
services:
  ion-drive:
    image: ionshift/ion-drive:latest
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://...
      
  postgres:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
```

### Future: Single Binary (via `pkg` or Bun compile)
For users who want zero Docker dependency.

---

## Key Technical Decisions Summary

| Decision | Choice | Key Reason |
|:---|:---|:---|
| Language | TypeScript | DX, LLM training data, your expertise |
| Runtime | Node.js 22+ (future: Bun) | Stability, ecosystem |
| Framework | Fastify | Dynamic routes, performance, plugins |
| Database | PostgreSQL 17 | JSONB, schemas, extensions, maturity |
| Query Builder | Kysely | Dynamic schema, raw SQL, type-safe system tables |
| Auth | Better Auth (default) | Self-hosted-first, pluggable |
| Observability | OpenTelemetry → Grafana stack | Vendor-neutral, cost-effective |
| Admin UI | React 19 + Vite | SPA for admin, no SSR needed |
| UI Components | shadcn/ui | Own your code, consistent philosophy |
| Monorepo | pnpm + Turborepo | Fast, proven, parallel builds |
| Testing | Vitest | Fast, Vite-native, great DX |
| Linting | Biome | Fast, single tool |
| API Spec | OpenAPI 3.1 (auto-generated) | Standard, LLM-friendly |
| GraphQL | Pothos (schema builder) | Code-first, dynamic schema support |
| Validation | Zod + TypeBox | Runtime + JSON Schema for OpenAPI |
