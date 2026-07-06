<div align="center">

# ⚡ Ion Drive

**The open-source platform for accelerated business software development.**

Runtime-dynamic data objects · Automatic REST/GraphQL/MCP APIs · Built for LLM agents

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-blue.svg)](https://postgresql.org)

</div>

---

## What is Ion Drive?

Ion Drive is a **self-hosted, open-source platform** that lets you define custom data objects, relationships, and business logic at runtime — then automatically generates REST, GraphQL, and MCP APIs for them. Think **self-hosted Firebase meets infinitely configurable ERP**, built from the ground up for AI-driven development.

### Key Features

- **🧩 Runtime Data Objects** — Create, modify, and delete tables through the admin console or API. No migrations, no deploys, no downtime.
- **🔌 Automatic API Surface** — Every data object instantly gets REST endpoints, GraphQL types, and MCP tools. Download an always-current OpenAPI spec.
- **🔎 Rich Querying** — Full-text `search`, per-property operators (`status[neq]=archived&age[gt]=21`), sorting, and pagination on every list endpoint — with a typed client SDK that builds the queries for you.
- **🤖 LLM/Agent Native** — Built-in MCP server lets AI agents introspect your schema and CRUD data with zero integration code.
- **📦 Building Blocks** — Pull in pre-built modules (CRM, invoicing, communications, audit) like `shadcn/ui` — you own the code, customize freely.
- **🏢 Multi-Tenant** — Designed for per-tenant database isolation (tenant management is on the [roadmap](docs/roadmap.md)).
- **📊 Built-in Observability** — OpenTelemetry instrumentation with optional Grafana stack. Pre-built dashboards included.
- **🔐 Pluggable Auth** — Better Auth (self-hosted) by default, swap to WorkOS/Auth0/Clerk via config.
- **⚙️ Admin Console** — Visual schema designer, Airtable-like data grid, user management, secrets vault, monitoring dashboards.

### Why Ion Drive?

| Problem | Ion Drive Solution |
|:---|:---|
| CMS platforms can't handle dynamic business logic | Runtime schema + automatic APIs |
| ERPs are rigid, dated, and painful to customize | Building blocks you own and modify |
| Every platform lacks AI/LLM integration | MCP server is a first-class citizen |
| Self-hosted = second-class citizen | Self-hosted is the primary target |
| Observability is always "add Datadog yourself" | OpenTelemetry + Grafana stack included |
| Multi-tenancy is always an afterthought | Database-per-tenant by design |

---

## Quick Start

### Prerequisites

- [Node.js 22+](https://nodejs.org)
- [pnpm 9+](https://pnpm.io)
- [Docker](https://docker.com) (for PostgreSQL)

### Setup

```bash
# Clone the repo
git clone https://github.com/ionshift/ion-drive.git
cd ion-drive

# Install dependencies
pnpm install

# Start PostgreSQL
docker compose -f docker/docker-compose.yml up -d

# Start the development server
pnpm dev
```

The Ion Drive API will be running at `http://localhost:3000` and the admin console at `http://localhost:3001`. The first user to sign up becomes the admin.

### Bootstrap a project with the CLI

```bash
npx ion-drive init      # scaffold config + an optional @ionshift/ion-drive-client starter
npx ion-drive list      # browse the block catalog
npx ion-drive add crm   # install CRM (objects, seed data, tasks) — APIs light up instantly
```

### Query it from code

```bash
npm install @ionshift/ion-drive-client
```

```ts
import { IonDriveClient } from '@ionshift/ion-drive-client';

const ion = new IonDriveClient({ baseUrl: 'http://localhost:3000' });

// Fluent + awaitable, inspired by Supabase:
const { data, pagination } = await ion.from('contacts')
  .select('id, full_name, email')
  .search('acme')                 // full-text across text-like columns
  .neq('status', 'archived')      // property + operator
  .gt('created_at', '2020-10-10')
  .order('created_at', { ascending: false })
  .range(0, 24);                  // offset-based paging
```

---

## Architecture

```
ion-drive/
├── packages/
│   ├── core/       # Fastify backend (schema engine, APIs, MCP, auth)
│   ├── admin/      # React admin console (Vite SPA)
│   ├── cli/        # CLI for project management and building blocks
│   ├── blocks/     # Official building block catalog (crm, invoicing, communications, audit)
│   └── client/     # Zero-dependency typed query builder + REST client SDK
├── docker/         # Docker Compose for dev and observability
└── docs/           # Documentation
```

### Tech Stack

| Layer | Technology |
|:---|:---|
| **Runtime** | Node.js 22+ |
| **Backend** | Fastify 5 |
| **Database** | PostgreSQL 17 |
| **Query Builder** | Kysely |
| **Validation** | Zod |
| **Auth** | Better Auth (pluggable) |
| **Admin UI** | React 19 + Vite |
| **Observability** | OpenTelemetry → Grafana/Loki/Tempo |
| **Monorepo** | pnpm + Turborepo |
| **Testing** | Vitest |
| **Linting** | Biome |

---

## Development

```bash
# Run all tests
pnpm test

# Type checking
pnpm typecheck

# Lint & format
pnpm lint:fix

# Build all packages
pnpm build
```

---

## Documentation

- [Getting Started](docs/getting-started.md)
- Concepts: [Data Objects](docs/concepts/data-objects.md) · [Building Blocks](docs/concepts/building-blocks.md)
- API: [Querying](docs/api/querying.md) · [REST](docs/api/rest.md) · [GraphQL](docs/api/graphql.md) · [MCP](docs/api/mcp.md)
- Deployment: [Docker](docs/deployment/docker.md)
- [Architecture Decisions](docs/research/architecture-decisions.md)
- [Research Findings](docs/research/research-findings.md)

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

[Apache 2.0](LICENSE) — IonShift Technologies LLC © 2026

> **Trademark Notice:** IonShift, IonShift Labs, IonShift Technologies LLC, and Ion Drive are trademarks of IonShift Technologies LLC. The Apache 2.0 license does not grant permission to use these marks. See [NOTICE](NOTICE) for full trademark terms.
