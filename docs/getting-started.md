# Getting Started

> This guide is also rendered (with the rest of the docs) at
> [iondrive.dev/docs/getting-started](https://iondrive.dev/docs/getting-started/).

Ion Drive is **the self-hostable, MCP-native backend an AI agent stands up in
minutes — with domain blocks you own as editable code.** This guide goes from
an empty machine to an agent creating and querying real data, in about five
minutes. You own the project it creates: a thin `server.ts` plus a `/blocks`
directory, with the platform arriving as npm dependencies (see
[Framework mode](concepts/framework-mode.md)).

## Prerequisites

- [Node.js 22+](https://nodejs.org)
- [Docker](https://docker.com) (for PostgreSQL)

## 1. Scaffold and run

```bash
npx @ion-drive/cli init my-app
cd my-app

docker compose up -d      # PostgreSQL
npm install
npm run dev               # tsx watch server.ts
```

- API: `http://localhost:3000`
- Admin console: `http://localhost:3000/admin`

Open the admin console and create your account — the **first user to sign up
becomes the admin**. (`.env` was generated with fresh secrets and
`ION_REQUIRE_AUTH=true`, so the API is authenticated from the first request.
Production hardening knobs are documented in `.env.example`.)

> Ion Drive will **refuse to boot in production** (`NODE_ENV=production`) with
> authentication disabled, unless you set `ION_ALLOW_OPEN=true` to acknowledge
> a deliberately open deployment. Keep `ION_REQUIRE_AUTH=true` for anything
> reachable by others.

> **Contributor path:** working on Ion Drive itself? Clone
> `jaredgrabill/ion-drive` and `pnpm dev` — see [CONTRIBUTING](https://github.com/jaredgrabill/ion-drive/blob/main/CONTRIBUTING.md).

## 2. Connect your agent

In the admin console go to **API Keys** and create a key **with a role
assigned** (e.g. `admin`) — a key with no role has no permissions. Then add the
MCP server to your agent:

```bash
# Claude Code, for example:
claude mcp add --transport http ion-drive http://localhost:3000/api/v1/mcp \
  --header "X-API-Key: iond_…"
```

Any MCP-compatible client works the same way — it's a Streamable HTTP server at
`/api/v1/mcp` (see [MCP server](api/mcp.md)). The scaffolded project also
contains an `AGENTS.md`, so coding agents working in the repo already know the
endpoints, the query language, and the schema-change etiquette.

## 3. Let the agent build

Ask your agent something like:

> Create a `contacts` object with a required full name, an email, and a status
> enum. Add a few sample records, then show me everyone whose status isn't
> `archived`.

The agent has MCP tools for all of it — `create_object`, `create_record`,
`query_data`, `modify_field` (preview-first), relationship management, and the
tools of any installed block. The moment an object is created it is **live on
every surface, no restart**:

- REST: `GET/POST/PATCH/DELETE /api/v1/data/contacts`
- GraphQL: `contacts`, `create_contacts`, … at `/api/v1/graphql`
- MCP: introspection + CRUD tools at `/api/v1/mcp`
- OpenAPI: reflected in `/api/v1/openapi.json`

Open **Objects → contacts** in the admin console and the records are there, in
an editable grid.

## 4. Bootstrap with building blocks

Instead of defining every object by hand, install a ready-made **building
block** — a bundle of objects, relationships, seed data, tasks, roles, and
(optionally) vendored logic:

```bash
npx ion-drive list             # the registry catalog (crm, invoicing, …)
npx ion-drive add crm          # schema-only: objects + APIs light up immediately
npx ion-drive add invoicing    # vendored logic: its code lands in blocks/invoicing/
```

Blocks with logic are **your code** — edit `blocks/invoicing/stripe.ts` and the
dev server hot-reloads. Their actions are live at
`POST /api/v1/blocks/invoicing/actions/create_payment_link`, in the OpenAPI
spec, and as MCP tools. See [Building Blocks](concepts/building-blocks.md) and
[Actions & hooks](api/actions.md). To author and ship your own block, see
[Publishing a block](concepts/building-blocks.md#publishing-a-block).

## 5. The same thing, by hand

Everything the agent does is a plain HTTP API you can drive yourself. Requests
are authenticated with the same header (`X-API-Key: iond_…`):

```bash
# Create an object
curl -X POST http://localhost:3000/api/v1/schema/objects \
  -H 'content-type: application/json' -H 'x-api-key: iond_…' \
  -d '{
    "name": "contacts",
    "displayName": "Contacts",
    "fields": [
      { "name": "full_name", "displayName": "Full Name", "columnType": "text", "isRequired": true },
      { "name": "email",     "displayName": "Email",     "columnType": "email" },
      { "name": "status",    "displayName": "Status",    "columnType": "enum" }
    ]
  }'

# Insert a record
curl -X POST http://localhost:3000/api/v1/data/contacts \
  -H 'content-type: application/json' -H 'x-api-key: iond_…' \
  -d '{ "full_name": "Ada Lovelace", "email": "ada@example.com", "status": "active" }'

# Query: full-text search plus per-property operators, sorting, pagination
curl -H 'x-api-key: iond_…' \
  "http://localhost:3000/api/v1/data/contacts?search=example&sort=-created_at&page=1"
curl -H 'x-api-key: iond_…' \
  "http://localhost:3000/api/v1/data/contacts?status[neq]=archived&created_at[gt]=2020-10-10"
```

See the [Querying guide](api/querying.md) for the full operator list.

## 6. Talk to it from code

Install the zero-dependency client SDK and use the fluent query builder:

```bash
npm install @ion-drive/client
```

```ts
import { IonDriveClient } from '@ion-drive/client';

const ion = new IonDriveClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'iond_…',
});

// Awaiting the fluent chain executes it (Supabase-style):
const { data, pagination } = await ion.from('contacts')
  .select('id, full_name, email')
  .search('example')
  .neq('status', 'archived')
  .gt('created_at', '2020-10-10')
  .order('created_at', { ascending: false })
  .range(0, 24);

console.log(data, pagination.totalCount);
```

## Next steps

- [Framework mode: the ownership model](concepts/framework-mode.md)
- [Core concepts: Data Objects](concepts/data-objects.md)
- [Querying: search, operators, pagination](api/querying.md)
- [REST API reference](api/rest.md)
- [GraphQL API reference](api/graphql.md)
- [MCP server](api/mcp.md)
- [Deploying with Docker](deployment/docker.md)
- [Deploying on Kubernetes](deployment/kubernetes.md)
- [Backup & Restore](deployment/backup-restore.md)
- [Security Checklist](deployment/security-checklist.md)
