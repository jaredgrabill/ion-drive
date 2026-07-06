# Getting Started with Ion Drive

A five-minute spin: run the server, define a data object, watch REST/GraphQL/MCP
light up for it, and see change events land in an audit log. For the fuller tour
see [docs/getting-started.md](docs/getting-started.md).

> **What is this?** Ion Drive lets you define data objects, relationships, and
> logic **at runtime** and automatically exposes them as REST, GraphQL, and MCP
> APIs — self-hosted, open-source, and built for AI-driven development. See the
> [README](README.md).

## Prerequisites

- [Node.js 22+](https://nodejs.org) · [pnpm 9+](https://pnpm.io) · [Docker](https://docker.com) (for PostgreSQL)

## 1. Run it

```bash
git clone https://github.com/jaredgrabill/ion-drive.git
cd ion-drive
pnpm install
docker compose -f docker/docker-compose.yml up -d   # PostgreSQL
pnpm dev                                             # API + admin console
```

- **API:** http://localhost:3000
- **Admin console:** http://localhost:3001 — open it and sign up. **The first
  user to sign up becomes the admin.**

## 2. Create a data object

Use the visual **Object Designer** in the console, or the API:

```bash
curl -X POST http://localhost:3000/api/v1/schema/objects \
  -H 'content-type: application/json' \
  -d '{
    "name": "contacts",
    "displayName": "Contacts",
    "fields": [
      { "name": "full_name", "displayName": "Full Name", "columnType": "text", "isRequired": true },
      { "name": "email",     "displayName": "Email",     "columnType": "email" }
    ]
  }'
```

The instant this returns, `contacts` is live — no restart — on **REST**
(`/api/v1/data/contacts`), **GraphQL** (`/api/v1/graphql`), **MCP**
(`/api/v1/mcp`), and the **OpenAPI** spec (`/api/v1/openapi.json`).

## 3. Add and query data

```bash
# Insert
curl -X POST http://localhost:3000/api/v1/data/contacts \
  -H 'content-type: application/json' \
  -d '{ "full_name": "Ada Lovelace", "email": "ada@example.com" }'

# Query — full-text search + per-property operators + sorting + pagination
curl "http://localhost:3000/api/v1/data/contacts?search=ada&sort=-created_at&page=1"
```

## 4. See change events in action (the audit log)

Every create/update/delete emits an event. Install the bundled **audit** block
to record them:

```bash
npx ion-drive add audit          # installs an audit_log object + subscribes to data changes
```

Now do a write and read the audit trail:

```bash
curl -X PATCH "http://localhost:3000/api/v1/data/contacts/<id>" \
  -H 'content-type: application/json' \
  -d '{ "full_name": "Ada King" }'

curl "http://localhost:3000/api/v1/data/audit_log?sort=-created_at"
# → one row per change: { operation, object_name, record_id, diff, snapshot, ... }
# the diff shows only the business field that changed (never updated_at)
```

That audit log is a building block consuming the message bus — the same seam a
plugin uses to swap the in-memory cache for Redis or wire up email. See
[Events & the Message Bus](docs/concepts/events.md) and [Plugins](docs/concepts/plugins.md).

## Bootstrap faster with building blocks

```bash
npx ion-drive init        # scaffold config + an optional typed-client starter
npx ion-drive list        # browse the catalog
npx ion-drive add crm     # install a whole domain (objects, seed data, roles) at once
```

## Where next

- [Full getting-started tour](docs/getting-started.md)
- [Core concepts](docs/concepts/data-objects.md) · [Building blocks](docs/concepts/building-blocks.md) · [Events](docs/concepts/events.md) · [Plugins](docs/concepts/plugins.md)
- [Querying](docs/api/querying.md) · [REST](docs/api/rest.md) · [GraphQL](docs/api/graphql.md) · [MCP](docs/api/mcp.md)
- [Deploying with Docker](docs/deployment/docker.md)
- Want to contribute? See [CONTRIBUTING.md](CONTRIBUTING.md).
