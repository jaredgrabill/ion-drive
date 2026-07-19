# REST API Reference

Every non-system data object automatically exposes a full CRUD surface under
`/api/v1/data/:object`. Objects are resolved per-request from the live schema
registry, so a newly created object's endpoints work **immediately** — no
restart, no redeploy.

A machine-readable, always-current [OpenAPI 3.1 spec](#openapi) is served at
`/api/v1/openapi.json`.

## Conventions

- **Base URL:** `http://localhost:3000` in development.
- **Content type:** `application/json`.
- **Auth:** when `ION_REQUIRE_AUTH` is enabled, send an API key as
  `X-API-Key: iond_…` (or `Authorization: Bearer iond_…`), or a session cookie.
- **Response envelope:** reads/writes of a single record return `{ "data": {…} }`;
  lists return `{ "data": [...], "pagination": {…} }`.
- **Errors:** `{ "error": "<code>", "message": "<human message>" }` with an
  appropriate HTTP status. Constraint violations add a `"field"` naming the
  offending column when it can be determined — see [Errors](#errors).

## Endpoints

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/v1/data` | Discovery — list available objects + their endpoints |
| `GET` | `/api/v1/data/:object` | List records (search, filter, sort, paginate) |
| `POST` | `/api/v1/data/:object` | Create a record |
| `POST` | `/api/v1/data/:object/bulk` | Bulk create (`{ "data": [...] }`) |
| `DELETE` | `/api/v1/data/:object/bulk` | Bulk delete (`{ "ids": [...] }`) |
| `GET` | `/api/v1/data/:object/:id` | Get one record by id |
| `PATCH` | `/api/v1/data/:object/:id` | Partial update — send only the fields you're changing |
| `DELETE` | `/api/v1/data/:object/:id` | Delete |
| `POST` | `/api/v1/data/:object/:id/links/:rel` | Add many_to_many links (`{ "ids": [...] }`, idempotent) |
| `DELETE` | `/api/v1/data/:object/:id/links/:rel` | Remove many_to_many links (`{ "ids": [...] }`) |

> There is deliberately no `PUT` full-replace verb: with runtime-defined schemas, replaying a
> stale full document would silently null out fields added since it was read. `PATCH` is the
> only update verb across REST, GraphQL, MCP, and the client SDK.

### List

```
GET /api/v1/data/contacts?search=acme&status[neq]=archived&sort=-created_at&page=1&pageSize=25
```

The query language (`search`, `field[operator]=value`, `sort`, `page`,
`pageSize`, `select`, `expand`) is documented in full in the
[Querying guide](querying.md).

```json
{
  "data": [
    { "id": "…", "full_name": "Ada Lovelace", "email": "ada@example.com", "status": "active" }
  ],
  "pagination": {
    "page": 1, "pageSize": 25, "totalCount": 1,
    "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false
  }
}
```

### Create

```bash
curl -X POST http://localhost:3000/api/v1/data/contacts \
  -H 'content-type: application/json' \
  -d '{ "full_name": "Ada Lovelace", "email": "ada@example.com" }'
# 201 Created -> { "data": { "id": "…", … } }
```

`json` fields take any JSON value directly — send the object or array itself,
no pre-encoding needed (a pre-encoded JSON string is also still accepted):

```bash
curl -X POST http://localhost:3000/api/v1/data/matches \
  -H 'content-type: application/json' \
  -d '{ "config_json": { "mode": "ranked", "rounds": [1, 2, 3] } }'
# 201 — and a GET returns the same parsed object
```

System fields (`id`, `created_at`, `updated_at`, `created_by`, `updated_by`)
are managed by the platform and ignored if supplied in the body. The `*_by`
columns record the authenticated actor (user id, else API-key id): creates
stamp both, updates re-stamp `updated_by`, and anonymous writes leave them
null.

### Get / Update / Delete

```bash
curl http://localhost:3000/api/v1/data/contacts/<id>                 # 200 or 404
curl -X PATCH http://localhost:3000/api/v1/data/contacts/<id> \
  -H 'content-type: application/json' -d '{ "status": "archived" }'  # 200 or 404
curl -X DELETE http://localhost:3000/api/v1/data/contacts/<id>       # 204 or 404
```

### Bulk

```bash
# Bulk create
curl -X POST http://localhost:3000/api/v1/data/contacts/bulk \
  -H 'content-type: application/json' \
  -d '{ "data": [ { "full_name": "A" }, { "full_name": "B" } ] }'
# 201 -> { "count": 2, "ids": ["…","…"] }

# Bulk delete
curl -X DELETE http://localhost:3000/api/v1/data/contacts/bulk \
  -H 'content-type: application/json' \
  -d '{ "ids": ["…","…"] }'
# -> { "count": 2, "ids": [...] }
```

## Status codes

| Code | When |
|:---|:---|
| `200` | Successful read/update |
| `201` | Record(s) created |
| `204` | Record deleted |
| `400` | Malformed body, unknown filter field, missing required field, or unparseable value |
| `401` / `403` | Auth required / insufficient permission (when enforcement is on) |
| `404` | Unknown object or record |
| `409` | Constraint conflict — duplicate unique value or foreign-key violation |

## Errors

Every error response uses the flat envelope
`{ "error": "<code>", "message": "<human message>" }`. Database constraint
violations are translated into stable, machine-readable codes — never a raw
500 with a SQLSTATE — and include a `"field"` naming the offending column
when it can be determined:

```json
{ "error": "unique_violation", "field": "device_id",
  "message": "A record with this device_id already exists" }
```

| Status | `error` | When |
|:---|:---|:---|
| `409` | `unique_violation` | A value duplicates an existing row in a unique field |
| `409` | `foreign_key_violation` | A referenced record doesn't exist, or the record is still referenced |
| `400` | `not_null_violation` | A required field is missing or null |
| `400` | `invalid_value` | A value can't be parsed as the column's type (bad UUID, non-numeric integer, malformed JSON string, …) |
| `400` | `CONSTRAINT_VIOLATION` | A field-level rule (min/max/pattern/enum) failed — the message names the rule |

Internal database identifiers (constraint names) never appear in responses.
These codes apply on every surface: GraphQL and MCP calls report the same
message through their own error channels. `409 unique_violation` is the
reliable "already exists" signal for GET-then-POST patterns.

## Using the client SDK

```ts
import { IonDriveClient } from '@ion-drive/client';
const ion = new IonDriveClient({ baseUrl: 'http://localhost:3000', apiKey });

const contacts = ion.from('contacts');
await contacts.select();                                  // GET (awaitable, all)
await contacts.select().search('acme').range(0, 24);      // GET (fluent query)
await contacts.select().eq('id', id).single();            // GET one (throws unless 1)
await contacts.get(id);                                   // GET /:id (null on 404)
await contacts.insert({ full_name: 'Ada' });              // POST (returns the row)
await contacts.insert([{ full_name: 'A' }, { full_name: 'B' }]); // POST /bulk (summary)
await contacts.update(id, { status: 'archived' });        // PATCH (null on 404)
await contacts.delete(id);                                // DELETE (false on 404)
await contacts.bulkDelete([id1, id2]);                    // DELETE /bulk
```

See the [Querying guide](querying.md#the-client-query-builder) for the full
fluent API (filters, `.order`, `.range`, `.single`/`.maybeSingle`).

## OpenAPI

`GET /api/v1/openapi.json` returns an OpenAPI 3.1 document generated from the
current schema. It documents every object's fields, the list query parameters
(including `search` and the filter operators), and request/response schemas —
point Swagger UI, Postman, or a codegen tool at it.
