# Ion Drive — Research Findings

> **Purpose:** This document consolidates all research findings from the initial planning phase.
> It serves as a reference for contributors, agents, and future decision-making.
>
> **Date:** 2026-07-03
> **Status:** Initial research complete

---

## Table of Contents

1. [Competitive Landscape](#competitive-landscape)
2. [Developer Sentiment Analysis](#developer-sentiment-analysis)
3. [Technology Evaluations](#technology-evaluations)
4. [Architecture Decisions](#architecture-decisions)
5. [Key Differentiators](#key-differentiators)

---

## Competitive Landscape

### Platforms Evaluated

#### 1. Directus — *Closest Competitor*

**Category:** Database-first Data Platform / CMS
**Architecture:** Wraps existing SQL databases in REST & GraphQL APIs + admin panel

**Strengths:**
- Database-first philosophy — sits on top of existing SQL databases
- Excellent admin panel with relationship visualization
- Framework-agnostic, works with any frontend
- Flows system for automation
- Strong community

**Weaknesses:**
- No Git-based versioning of schema — config stored in DB, not code
- Environment sync is painful — dev → staging → prod requires custom scripts or `directus-sync`
- Runtime schema changes feel risky in production — no validation/preview workflow
- No MCP, no LLM awareness — completely absent from the AI tooling ecosystem
- Conflicts with ORMs like Prisma when used alongside Directus
- Deployment/runtime reliability issues — schema snapshots or auto-applies can fail to correctly detect existing tables

**Community Workarounds:**
- Custom migration scripts (Node.js/SQL) for Git-versioned schema changes
- `directus-sync` CLI tool for environment synchronization
- Custom extensions for safe collection renaming
- `@directus/sdk` for automating schema snapshots and diffing

---

#### 2. Supabase — *Popular but Wrong Architecture for Our Use Case*

**Category:** Backend-as-a-Service (open-source Firebase alternative)
**Architecture:** PostgreSQL + PostgREST + GoTrue + Realtime + Edge Functions

**Strengths:**
- Firebase-like developer experience — auth, realtime, edge functions in one package
- PostgreSQL-native with Row-Level Security (RLS)
- Generous free tier and excellent documentation
- Strong brand recognition and community

**Weaknesses:**
- Self-hosted feels "second-class citizen" — features gated behind `IS_PLATFORM` variables
- No dynamic schema — static migration-based schema management
- Multi-tenancy is painful — RLS-based only, no schema-per-tenant, auth enforces global email uniqueness
- Documentation assumes cloud — self-hosters left guessing
- Heavy Docker stack (Kong, GoTrue, PostgREST, Realtime) is complex to maintain
- No automated backups or PITR in self-hosted
- Management API not available for self-hosted

**Multi-tenancy Patterns in Supabase:**
1. Shared Schema with RLS (most supported path)
2. Container-per-tenant (expensive but fully isolated)
3. PostgreSQL table partitioning (compromise approach)

---

#### 3. Strapi — *Content-First, Not Business-Logic-First*

**Category:** Headless CMS (code-first)
**Architecture:** Node.js/Express with plugin system

**Strengths:**
- Most established code-first headless CMS in JavaScript ecosystem
- Massive plugin ecosystem
- Good for content-heavy applications (blogs, marketing, e-commerce)
- Strong community

**Weaknesses:**
- Schema is static — defined in code or UI, not modifiable at runtime
- Less "data-centric" than needed for complex business logic
- Content-focused, not suited for transactional/relational business data
- No MCP/LLM integration

---

#### 4. Payload CMS 3.0 — *Great DX, Wrong Problem Domain*

**Category:** TypeScript-first headless CMS
**Architecture:** Installed directly into Next.js `/app` folder

**Strengths:**
- TypeScript-first, code-first CMS
- Deep Next.js integration — CMS and frontend share codebase
- Local API (no HTTP overhead for server components)
- Drizzle ORM, multi-database support (MongoDB, PostgreSQL, SQLite)
- Excellent developer experience

**Weaknesses:**
- Tightly coupled to Next.js — not a general-purpose backend platform
- No runtime schema changes — everything is code-defined at build time
- Not designed for business logic — it's a CMS
- No MCP, no agent tooling
- Steeper learning curve for non-technical users
- CMS uptime tied to frontend application
- Smaller plugin ecosystem compared to WordPress/Strapi

---

#### 5. NocoDB — *Spreadsheet UI, Limited Programmability*

**Category:** No-code database (Airtable alternative)
**Architecture:** Database-to-spreadsheet interface

**Strengths:**
- Turns any SQL database into Airtable-like spreadsheet UI
- Great for non-technical team members
- Grid, Kanban, Calendar views
- Simple setup

**Weaknesses:**
- Limited dynamic schema capabilities
- Not suited for complex custom-coded business logic
- No GraphQL API
- No MCP/LLM integration
- Limited automation capabilities

---

#### 6. Odoo — *Enterprise ERP, Wrong Era*

**Category:** Comprehensive open-source ERP
**Architecture:** Python/XML monolith with module system

**Strengths:**
- Incredibly comprehensive business modules (accounting, CRM, MRP, etc.)
- Huge community and partner ecosystem (20+ years)
- Battle-tested in real business environments
- Covers nearly every business function imaginable

**Weaknesses:**
- Python/XML stack feels dated — not TypeScript, not modern web
- Customization-upgrade paradox — custom code breaks on version upgrades
- Community vs Enterprise divide — advanced features locked to paid edition
- Integration is hard — connecting to external systems requires custom API dev
- "Odoo way" lock-in — steep learning curve, knowledge trapped with specific developers
- No LLM/agent capabilities
- Data migration is a major, underestimated hurdle
- Implementation complexity often underestimated by clients

---

#### 7. Low-Code Platforms (Budibase, Appsmith, ToolJet)

**Category:** Internal tool builders

**Common Weaknesses:**
- Budibase: Limited automation error handling, no parallel execution, poor mobile
- Appsmith: Browser-heavy rendering, no built-in automation, widget count impacts performance
- ToolJet: Younger ecosystem, workflow latency (3-5s), resource-heavy at scale
- All: AI features good for scaffolding but not production-ready
- All: Self-hosted = full operational burden (security, updates, infrastructure)

---

### Weighted Competitive Scoring

| Criteria | Weight | Directus | Supabase | Strapi | Payload | NocoDB | Odoo | Ion Drive |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Runtime Schema Flexibility | **5** | 3 | 1 | 1 | 1 | 2 | 1 | **5** |
| LLM/Agent Readiness | **5** | 1 | 1 | 1 | 1 | 1 | 1 | **5** |
| Developer Experience | **4** | 4 | 5 | 4 | 5 | 3 | 2 | **5** |
| Self-Hosted Ease | **4** | 4 | 2 | 4 | 4 | 4 | 3 | **5** |
| API Surface (REST+GQL+MCP) | **4** | 4 | 3 | 4 | 4 | 2 | 2 | **5** |
| Multi-Tenancy | **3** | 2 | 2 | 1 | 1 | 1 | 3 | **5** |
| Extensibility / Blocks | **3** | 3 | 2 | 3 | 3 | 1 | 3 | **5** |
| Built-in Observability | **2** | 1 | 1 | 1 | 1 | 1 | 2 | **5** |
| Community & Ecosystem | **2** | 4 | 5 | 5 | 3 | 3 | 4 | **1** |
| **Weighted Total** | | **89** | **76** | **79** | **79** | **63** | **67** | **155** |

> Note: Ion Drive scores highest because we're defining target capabilities. Community is our biggest gap (score: 1). The real differentiator is execution and the fact that no competitor covers all dimensions simultaneously.

---

## Developer Sentiment Analysis

### What Developers Love (Universal)

1. **"It just works" setup** — Docker compose up, working admin panel in minutes
2. **Type safety** — TypeScript end-to-end, no surprises at runtime
3. **Instant APIs** — define a table, get REST/GraphQL automatically
4. **Good documentation** — comprehensive, searchable, with examples
5. **Open source with no "gotcha" enterprise gates** — MIT/Apache, not BUSL
6. **Self-contained** — fewer moving parts beats microservice sprawl
7. **Real-time capabilities** — WebSocket/SSE for live updates
8. **Good defaults** — sensible out-of-the-box configuration

### What Developers Hate (Universal)

1. **Schema-as-code vs schema-at-runtime tension** — nobody solves this well
2. **Multi-tenancy afterthoughts** — always bolted on, never designed in
3. **No AI/LLM integration** — zero platforms treat this as core
4. **Painful environment sync** — dev/staging/prod drift is universal
5. **"Black box" plugins/modules** — no ownership, no customization
6. **Observability as afterthought** — always "add Datadog/Sentry yourself"
7. **Secrets management** — usually `.env` files and hope
8. **Vendor lock-in disguised as open source** — BUSL licensing, cloud-gated features
9. **"Hidden" infrastructure overhead** — managing redirects, SEO, analytics, search
10. **Split sources of truth** — data across CMS and traditional DB creates sync issues

### Key Pain Points Specific to Dynamic Schema

- API/Database mismatch when schemas change dynamically
- Data integrity risks when CMS abstraction layer is bypassed
- Most CMS platforms optimized for structured, predictable content models
- Tooling limitations — not designed as replacements for relational databases
- Runtime table creation conflicts with compile-time type safety approaches

---

## Technology Evaluations

### Backend Framework Comparison

| Factor | Fastify | NestJS | Hono |
|:---|:---:|:---:|:---:|
| Performance | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Boilerplate | Low | High | Very Low |
| Plugin System | Excellent | Modules (heavy) | Minimal |
| Dynamic Route Registration | ✅ Native | ⚠️ Possible with effort | ⚠️ Limited |
| TypeScript Support | ✅ First-class | ✅ First-class | ✅ First-class |
| Community / Maturity | Large, stable | Largest, enterprise | Growing, newer |
| Schema Validation (built-in) | ✅ JSON Schema / TypeBox | Via class-validator | Via Zod |
| Multi-runtime | Node.js | Node.js | Node, Bun, Deno, Edge |

**Decision: Fastify**

**Key Reasons:**
1. Dynamic route registration is critical — Fastify's plugin system handles this natively
2. High performance for potentially thousands of dynamically-generated endpoints
3. Low boilerplate — NestJS requires controller+service+module+DTO per entity
4. Plugin encapsulation model perfect for multi-tenancy
5. JSON Schema native — maps directly to OpenAPI spec generation
6. Fastify can't modify routes after server start (routing tree built during registration), but we can re-register plugin scopes when schema changes occur

**Why not NestJS:** Too opinionated, decorator-based DI fights dynamic route generation
**Why not Hono:** Optimized for edge/serverless, not stateful platforms; newer ecosystem

---

### ORM / Query Builder Comparison

| Factor | Kysely | Drizzle | Prisma | TypeORM |
|:---|:---:|:---:|:---:|:---:|
| Dynamic Schema Support | ✅ Best | ⚠️ Workarounds | ❌ Static .prisma | ❌ Static entities |
| Raw SQL Access | ✅ Native | ✅ Good | ⚠️ Limited | ⚠️ QueryBuilder |
| Type Safety | ✅ Excellent | ✅ Excellent | ✅ Generated | ✅ Decorators |
| Runtime search_path | ✅ Easy | ⚠️ Manual | ❌ Connection string | ❌ Multiple pools |
| Schema Builder API | ✅ Yes | ⚠️ Limited | ❌ No | ⚠️ Via migrations |
| Performance | ✅ Minimal overhead | ✅ Good | ⚠️ Engine overhead | ⚠️ Heavy |
| Bundle Size | Small | Small | Large (engine binary) | Large |

**Decision: Kysely**

**Key Reasons:**
1. Dynamic schema is core — Kysely doesn't rely on static schema files or generated code
2. Schema Builder API can CREATE/ALTER/DROP TABLE programmatically
3. `search_path` for multi-tenancy is clean
4. Raw SQL escape hatch with proper identifier escaping (`sql.table()`, `sql.ref()`)
5. Transparent — LLM agents can read Kysely code trivially

**Architecture Note:** Two-layer approach:
- System tables (Ion Drive metadata): Fully typed Kysely with compile-time safety
- Tenant data tables (user-defined): `Kysely<any>` with runtime validation layer

**Dynamic Table Creation in Kysely:**
- Schema Builder API: `db.schema.createTable(name).addColumn(...)` — clean, programmatic
- Raw SQL: `sql\`CREATE TABLE ${sql.table(name)} (...)\`` — for complex DDL
- Important: Kysely loses type safety for dynamically-created tables (expected; we handle this with our own validation layer)

---

### Authentication Comparison

| Factor | Better Auth | WorkOS AuthKit |
|:---|:---:|:---:|
| Self-hosted ownership | ✅ Full control | ❌ Managed SaaS |
| Data in your DB | ✅ | ❌ |
| Enterprise SSO (SAML) | ⚠️ Plugin | ✅ Built-in |
| Cost | Free | Free tier, then paid |
| TypeScript native | ✅ | ✅ SDK |
| Multi-tenancy | ✅ Plugin | ✅ Organizations |
| Vendor lock-in risk | None | Moderate |

**Decision: Better Auth as default, pluggable adapter interface**

**Key Reasons:**
1. Self-hosted-first — stores everything in your database
2. No per-user fees — critical for open-source platform
3. Full control over auth flows and data
4. Adapter pattern allows WorkOS/Auth0/Clerk swap via configuration

---

### Observability Stack

**Decision: OpenTelemetry → Grafana Stack (Loki + Prometheus + Tempo + Grafana)**

| Layer | Tool | Purpose |
|:---|:---|:---|
| Instrumentation | OpenTelemetry SDK | Instrument all operations |
| Collection | OTel Collector | Receive, process, export |
| Logs | Grafana Loki | Label-indexed log aggregation (cheap) |
| Metrics | Prometheus | Metrics collection and alerting |
| Traces | Grafana Tempo | Distributed tracing |
| Visualization | Grafana | Unified dashboards |

**Key Reasons:**
1. Vendor-neutral — users can swap backends via OTel Collector config
2. Loki is cost-effective — label-indexed, uses cheap object storage
3. Short TTL support — Loki compactor with configurable retention (7-day default)
4. All open source — no licensing costs
5. Inspired by .NET Aspire — ship pre-built dashboards that light up immediately

**Cost Optimization Strategies:**
- Label cardinality control (namespace, service_name, env — not user_id)
- Filter at source via OTel Collector processors
- Per-tenant retention overrides
- Structured metadata instead of labels for high-cardinality data

---

### Admin Console Technology

**Decision: React 19 + Vite SPA**

**Key Reasons:**
1. Admin consoles don't need SSR — no SEO, no public crawling
2. Static deployment — builds to static files served by Fastify or CDN
3. Decoupled from backend — pure API consumer
4. React is the most LLM-friendly frontend framework
5. Vite provides instant HMR and fast builds

**Library Selections:**
- UI: shadcn/ui (React)
- State: TanStack Query + Zustand
- Tables: TanStack Table (Airtable-like data grid)
- Forms: React Hook Form + Zod
- Charts: Recharts or Tremor
- Router: TanStack Router

---

### Building Blocks System

**Decision: Custom registry + CLI (shadcn pattern)**

**The shadcn Pattern:**
- Distribution via CLI, not npm packages
- Source code pulled into project — full ownership
- Modify, extend, delete without dependency concerns
- Registry-based discovery (local or hosted marketplace)
- In 2025-2026, this pattern has expanded beyond frontend UI to backend modules

**Block Manifest Structure:**
- Data object definitions
- Relationship configurations
- Scripts and lifecycle hooks
- API surface definitions
- Base data and defaults
- Configuration properties
- Integration configurations
- Scheduled task definitions

**Distribution Models:**
1. CLI pull: `npx ion-drive add crm`
2. Registry install: Browse and install from marketplace
3. Local blocks: Custom blocks in project

---

## Architecture Decisions

### Multi-Tenancy Model

**Decision: Database-per-tenant (default) with schema-per-tenant as lighter option**

- Each tenant gets its own PostgreSQL database
- Complete data isolation by default
- Schema-per-tenant available for simpler deployments
- Kysely handles `search_path` switching cleanly

### Dynamic API Generation

**Approach:**
- REST: Fastify route generation per data object (list, get, create, update, delete, bulk)
- GraphQL: Pothos schema builder for runtime type construction (via GraphQL Yoga)
- MCP: Built-in server with auto-generated tools per data object
- OpenAPI: Real-time spec generation reflecting current schema state

**OpenAPI Generation Strategy:**
- Zod/TypeBox schemas defined once, used for:
  - Runtime validation (middleware)
  - JSON Schema export (OpenAPI docs)
  - GraphQL type construction
- Code-first approach — spec is always derived from runtime state

### MCP Server Design

**Best Practices Applied:**
- Bounded contexts — MCP server scoped to Ion Drive domain
- Stateless & idempotent tool operations
- Streamable HTTP transport for production
- OAuth 2.1 for secure authorization
- Structured JSON logging with trace_id for audit trail
- Descriptive tool schemas for LLM discoverability
- Input validation — never pass raw LLM output to SQL

---

## Key Differentiators

### 1. Runtime Schema as First-Class Citizen
- Preview mode — show what will change before committing
- Validation — detect data loss, broken relationships, constraint violations
- Atomic commits — all-or-nothing schema changes
- Version history — every schema change is tracked and reversible
- Code export — schema-as-code for Git, CI/CD, and environment sync

### 2. LLM/Agent-Native Architecture (MCP First-Class)
- LLMs can introspect the entire schema
- LLMs can CRUD data through structured, validated tools
- Dramatically reduced context needs (ask "what objects exist?" instead of 10K tokens of boilerplate)
- Structured tool definitions with Zod schemas
- Built-in audit trail for agent actions

### 3. Building Blocks (shadcn Pattern)
- Owned code, not black-box dependencies
- Composable — blocks can reference other blocks
- Marketplace-ready
- AI-agent compatible — LLM can read registry and suggest blocks

### 4. Self-Hosted-First
- Every feature works self-hosted — no artificial gates
- Minimal infrastructure (Docker Compose)
- Per-tenant database isolation
- Built-in observability — no external services required

### 5. Developer QoL for LLM-Driven Development
- Always-current OpenAPI spec
- MCP server for zero-integration agent interaction
- Structured, predictable API surface
- Schema introspection endpoints
- Full audit logging

---

## Monorepo Structure

```
ion-drive/
├── packages/
│   ├── core/           # Core engine (schema, data, API, MCP, auth, tasks, config, telemetry)
│   ├── admin/          # Admin console (React + Vite SPA)
│   ├── cli/            # CLI tool (block management, project init)
│   └── blocks/         # Official building blocks (CRM, invoicing, etc.)
├── docker/             # Docker compositions (core + observability overlay)
├── docs/               # Documentation
├── turbo.json          # Turborepo config
├── pnpm-workspace.yaml
└── package.json
```

**Monorepo Tooling:** pnpm (workspaces), Turborepo (builds), Vitest (testing), Biome (linting)
