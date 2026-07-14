<div align="center">

# ⚡ Ion Drive

**The self-hostable, MCP-native backend an AI agent stands up in minutes —
with domain blocks you own as editable code.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-blue.svg)](https://postgresql.org)

</div>

```bash
npx @ion-drive/cli init my-app && cd my-app
docker compose up -d && npm install
npm run dev              # REST + GraphQL + MCP + admin console, live at :3000
npx ion-drive add crm    # domain blocks land as editable code in blocks/
```

Point a coding agent at **`http://localhost:3000/api/v1/mcp`** and it can define
tables, insert records, and query them — no migrations, no codegen, no deploy.
Every object it creates is instantly a REST endpoint, a GraphQL type, an MCP
tool, and a row in the admin console. **Your agent gets REST + GraphQL + MCP
for free; blocks are code you own, not a marketplace lock-in.**

---

## The five minutes, spelled out

**Prerequisites:** [Node.js 22+](https://nodejs.org) and [Docker](https://docker.com) (for PostgreSQL).

1. **Scaffold + boot** (the four commands above). What you own is deliberately
   small — a `server.ts` composition root and a `/blocks` directory; the
   platform arrives as npm dependencies
   ([framework mode](docs/concepts/framework-mode.md)).
2. **Open `http://localhost:3000/admin`** and sign up — the first user becomes
   admin, then signup can be locked. Auth is **on by default**.
3. **Mint your agent's key:** admin console → API Keys → create a key **with a
   role** (e.g. `admin`). Then connect any MCP client:

   ```bash
   # Claude Code, for example:
   claude mcp add --transport http ion-drive http://localhost:3000/api/v1/mcp \
     --header "X-API-Key: iond_…"
   ```

4. **Ask the agent to build.** "Create a `launch_notes` object with title, body
   and priority; add three records; show me the high-priority ones." Watch the
   data appear in the admin grid. The scaffold ships an `AGENTS.md` so agents
   already know the ropes.

The full tour lives in [Getting Started](docs/getting-started.md)
([rendered](https://iondrive.dev/docs/getting-started/)).

## Blocks: domain features as code you own

```bash
npx ion-drive list             # browse the registry catalog
npx ion-drive add crm          # schema-only: objects + APIs light up instantly
npx ion-drive add invoicing    # vendored logic: Stripe integration lands in blocks/invoicing/
```

Installing a block applies its schema *and* drops its business logic into
`blocks/<name>/` in **your repo** — like `shadcn/ui`, but for backend features.
Edit `blocks/invoicing/stripe.ts`; the dev server hot-reloads, and its action
stays live at `POST /api/v1/blocks/invoicing/actions/create_payment_link`, in
OpenAPI, and as an MCP tool. Upstream updates arrive as diffs you review
(`ion-drive diff` / `update`), never overwrites. Every artifact is
digest-verified and (for official blocks) sigstore-attested at install.

Built a block of your own? `ion-drive block new` scaffolds it and
`ion-drive block publish` ships it to any git-hosted registry — see
[Building Blocks](docs/concepts/building-blocks.md).

## Query it from code

```bash
npm install @ion-drive/client
```

```ts
import { IonDriveClient } from '@ion-drive/client';

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

## What's underneath

Ion Drive is a **self-hosted, open-source application backend**: define data
objects, relationships, and logic at runtime; the platform generates the API
surfaces. Think *self-hosted Firebase meets an infinitely configurable ERP*,
built from the ground up for AI-driven development. All of this exists today —
it's proof, not pitch:

- **🧩 Runtime data objects** — create, modify, and delete tables through the
  admin console or any API; preview-first schema changes (dry-run shows the
  exact SQL + warnings); CHECK constraints, relations, snapshot/diff/push and
  a drift doctor.
- **🔌 Automatic API surface** — REST, GraphQL (full relational traversal +
  subscriptions), MCP tools, and an always-current OpenAPI spec, all backed by
  one shared data service.
- **🔎 Rich querying** — full-text `search`, per-property operators
  (`status[neq]=archived&age[gt]=21`), sorting, pagination, `expand=` for
  relations — identical on every surface.
- **⚡ Events to the edge** — transactional outbox, consumer groups with
  retry/backoff + DLQ, signed outbound webhooks, realtime SSE and GraphQL
  subscriptions, actor identity on every change.
- **🔐 Auth + RBAC on by default** — Better Auth (pluggable), API keys, roles
  with permission grants enforced across REST/GraphQL/MCP; secrets vault
  (AES-256-GCM); signup lockout; production boot refuses unsafe configs.
- **📊 Built-in observability** — OpenTelemetry traces/metrics/logs, `/metrics`
  for Prometheus, an optional Grafana/Loki/Tempo compose overlay, live logs and
  charts in the admin console.
- **⚙️ Admin console** — visual schema designer, data grid with inline editing,
  users/roles, tasks, events, webhooks, metrics — served by the backend at
  `/admin`.
- **🔧 Extensible runtime** — plugin host with provider ports (cache, email,
  storage, message bus, logging); first-party Redis, SendGrid, and S3 plugins;
  scheduled tasks with a handler registry.

## Architecture

```
ion-drive/
├── packages/
│   ├── core/       # Fastify backend (schema engine, APIs, MCP, auth)
│   ├── admin/      # React admin console (Vite SPA)
│   ├── cli/        # CLI for project management, building blocks, and registry publishing
│   ├── plugin-*/   # First-party infra plugins (redis, sendgrid, storage-s3)
│   └── client/     # Zero-dependency typed query builder + REST client SDK
├── docker/         # Docker Compose for dev and observability
└── docs/           # Documentation
```

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

The non-obvious choices (Fastify over Nest, Kysely over Prisma, graphql-js over
Pothos) are deliberate and documented in
[Architecture Decisions](docs/research/architecture-decisions.md).

## Development

Contributing to Ion Drive itself? Clone this repo, then:

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d   # dev PostgreSQL
pnpm dev            # watch mode
pnpm test           # unit tests
pnpm test:integration
pnpm typecheck && pnpm lint:fix
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Documentation

Rendered docs live at **[iondrive.dev](https://iondrive.dev)** ([getting
started](https://iondrive.dev/docs/getting-started/), plus a browser for the
[block registry](https://iondrive.dev/blocks/)). The same pages in-repo:

- [Getting Started](docs/getting-started.md)
- Concepts: [Data Objects](docs/concepts/data-objects.md) · [Building Blocks](docs/concepts/building-blocks.md) · [Framework Mode](docs/concepts/framework-mode.md) · [Events](docs/concepts/events.md) · [Plugins](docs/concepts/plugins.md)
- API: [Querying](docs/api/querying.md) · [REST](docs/api/rest.md) · [GraphQL](docs/api/graphql.md) · [MCP](docs/api/mcp.md) · [Actions](docs/api/actions.md) · [Realtime](docs/api/realtime.md)
- Deployment: [Docker](docs/deployment/docker.md) · [Kubernetes](docs/deployment/kubernetes.md) · [Backup & Restore](docs/deployment/backup-restore.md) · [Security Checklist](docs/deployment/security-checklist.md)
- [Architecture Decisions](docs/research/architecture-decisions.md)

## License

[Apache 2.0](LICENSE) — IonShift Technologies LLC © 2026

> **Trademark Notice:** IonShift, IonShift Labs, IonShift Technologies LLC, and Ion Drive are trademarks of IonShift Technologies LLC. The Apache 2.0 license does not grant permission to use these marks. See [NOTICE](NOTICE) for full trademark terms.
