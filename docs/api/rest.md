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
  appropriate HTTP status.

## Endpoints

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/v1/data` | Discovery — list available objects + their endpoints |
| `GET` | `/api/v1/data/:object` | List records (search, filter, sort, paginate) |
| `POST` | `/api/v1/data/:object` | Create a record |
| `POST` | `/api/v1/data/:object/bulk` | Bulk create (`{ "data": [...] }`) |
| `DELETE` | `/api/v1/data/:object/bulk` | Bulk delete (`{ "ids": [...] }`) |
| `GET` | `/api/v1/data/:object/:id` | Get one record by id |
| `PATCH` | `/api/v1/data/:object/:id` | Partial update |
| `DELETE` | `/api/v1/data/:object/:id` | Delete |

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

System fields (`id`, `created_at`, `updated_at`) are managed by the platform and
ignored if supplied in the body.

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
| `400` | Malformed body or unknown filter field |
| `401` / `403` | Auth required / insufficient permission (when enforcement is on) |
| `404` | Unknown object or record |

## Using the client SDK

```ts
import { IonDriveClient } from '@ionshift/ion-drive-client';
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
