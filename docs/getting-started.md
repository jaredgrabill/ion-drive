# Getting Started

This guide takes you from an empty machine to a running Ion Drive backend with
a custom data object, live APIs, and a typed client — in about five minutes.
You'll own the project it creates: a thin `server.ts` plus a `/blocks`
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

The **first user to sign up becomes the admin**. Open the admin console and
create your account. (`.env` was generated with fresh secrets; production
hardening knobs are documented in `.env.example`.)

> **Contributor path:** working on Ion Drive itself? Clone
> `jaredgrabill/ion-drive` and `pnpm dev` — see [CONTRIBUTING](../CONTRIBUTING.md).

## 2. Create a data object

You can use the visual **Object Designer** in the admin console, or the API
directly. Here is the API:

```bash
curl -X POST http://localhost:3000/api/v1/schema/objects \
  -H 'content-type: application/json' \
  -d '{
    "name": "contacts",
    "displayName": "Contacts",
    "fields": [
      { "name": "full_name", "displayName": "Full Name", "columnType": "text", "isRequired": true },
      { "name": "email",     "displayName": "Email",     "columnType": "email" },
      { "name": "status",    "displayName": "Status",    "columnType": "enum" },
      { "name": "created_at","displayName": "Created",   "columnType": "datetime" }
    ]
  }'
```

The moment this returns, the object is **live on every surface** — no restart:

- REST: `GET/POST/PATCH/DELETE /api/v1/data/contacts`
- GraphQL: `contacts`, `create_contacts`, … at `/api/v1/graphql`
- MCP: tools for any connected LLM agent at `/api/v1/mcp`
- OpenAPI: reflected in `/api/v1/openapi.json`

## 3. Add some data

```bash
curl -X POST http://localhost:3000/api/v1/data/contacts \
  -H 'content-type: application/json' \
  -d '{ "full_name": "Ada Lovelace", "email": "ada@example.com", "status": "active" }'
```

## 4. Query it

Ion Drive has a rich, URL-friendly query language — full-text search plus
per-property operators, sorting, and pagination:

```bash
# Everything matching "example", newest first, page 1
curl "http://localhost:3000/api/v1/data/contacts?search=example&sort=-created_at&page=1"

# Property operators: status not archived AND created after a date
curl "http://localhost:3000/api/v1/data/contacts?status[neq]=archived&created_at[gt]=2020-10-10"
```

See the [Querying guide](api/querying.md) for the full operator list.

## 5. Talk to it from code

Install the zero-dependency client SDK and use the fluent query builder:

```bash
npm install @ion-drive/client
```

```ts
import { IonDriveClient } from '@ion-drive/client';

const ion = new IonDriveClient({ baseUrl: 'http://localhost:3000' });

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

## 6. Bootstrap with building blocks

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
