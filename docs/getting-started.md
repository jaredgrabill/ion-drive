# Getting Started

This guide takes you from an empty machine to a running Ion Drive server with a
custom data object, live APIs, and a typed client — in about five minutes.

## Prerequisites

- [Node.js 22+](https://nodejs.org)
- [pnpm 9+](https://pnpm.io)
- [Docker](https://docker.com) (for PostgreSQL)

## 1. Install and run

```bash
git clone https://github.com/ionshift/ion-drive.git
cd ion-drive
pnpm install

# Start PostgreSQL
docker compose -f docker/docker-compose.yml up -d

# Start the dev server (core API + admin console)
pnpm dev
```

- API: `http://localhost:3000`
- Admin console: `http://localhost:3001`

The **first user to sign up becomes the admin**. Open the admin console and
create your account.

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
npm install @ionshift/ion-drive-client
```

```ts
import { IonDriveClient } from '@ionshift/ion-drive-client';

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
block** — a bundle of objects, relationships, seed data, tasks, and roles — with
the CLI:

```bash
npx ion-drive init        # scaffold ion.config.json + an optional client starter
npx ion-drive list        # see the catalog (crm, invoicing, communications, audit)
npx ion-drive add crm     # install CRM (and resolve its dependencies)
```

See [Building Blocks](concepts/building-blocks.md).

## Next steps

- [Core concepts: Data Objects](concepts/data-objects.md)
- [Querying: search, operators, pagination](api/querying.md)
- [REST API reference](api/rest.md)
- [GraphQL API reference](api/graphql.md)
- [MCP server](api/mcp.md)
- [Deploying with Docker](deployment/docker.md)
- [Deploying on Kubernetes](deployment/kubernetes.md)
- [Backup & Restore](deployment/backup-restore.md)
- [Security Checklist](deployment/security-checklist.md)
