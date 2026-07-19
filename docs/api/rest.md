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
  Objects granted `read` to the built-in `public` role are also readable with
  **no credential at all** — see [Public read access](../concepts/public-read.md).
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
| `GET` | `/api/v1/data/:object/aggregate` | Aggregate the filtered rows (`fn=count\|sum\|avg\|min\|max`) |
| `POST` | `/api/v1/data/:object` | Create a record (`?on_conflict=col[,col2]` → upsert) |
| `POST` | `/api/v1/data/:object/bulk` | Bulk create (`{ "data": [...] }`) |
| `DELETE` | `/api/v1/data/:object/bulk` | Bulk delete (`{ "ids": [...] }`) |
| `GET` | `/api/v1/data/:object/:id` | Get one record by id |
| `PATCH` | `/api/v1/data/:object/:id` | Partial update — send only the fields you're changing; numeric fields accept `{ "$inc": n }` |
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

### Aggregate

```
GET /api/v1/data/players/aggregate?fn=avg&field=damage_dealt&match_count[gte]=10
```

A single `count`/`sum`/`avg`/`min`/`max` over the rows matching the same
filter + search parameters as the list endpoint. Returns
`{ "data": { "fn", "field", "value", "filteredCount" } }`. See the
[Leaderboards & aggregates guide](querying.md#leaderboards--aggregates) for
the full reference and the rank-via-`totalCount` pattern.

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

### Upsert (create-or-update)

Add `?on_conflict=<col>[,<col2>]` to the create POST to run a PostgREST-style
upsert — one atomic `INSERT … ON CONFLICT (…) DO UPDATE` statement, so two
concurrent first-time writers can never race each other into a unique
violation:

```bash
curl -X POST 'http://localhost:3000/api/v1/data/player_stats?on_conflict=device_id'   -H 'content-type: application/json'   -d '{ "device_id": "abc", "wins": 1 }'
# 201 Created -> { "data": { … }, "created": true }    (row was inserted)
# 200 OK      -> { "data": { … }, "created": false }   (existing row updated)
```

- The conflict target must be a **declared** unique constraint: a single
  `isUnique` field, the primary key (`id`), or one of the object's
  [`constraints.uniqueTogether`](../concepts/data-objects.md#composite-unique-constraints-uniquetogether)
  groups (columns in any order) — anything else is a `400` naming the valid
  targets.
- Every conflict column must appear in the body (that's the row's identity).
- All non-conflict columns from the body overwrite the existing row on
  conflict; columns you omit keep their values. `created_by` is never
  overwritten; `updated_by`/`updated_at` re-stamp.
- The response gains a `created` indicator beside the usual `data` envelope.

### Atomic increments

Counter-style columns can be updated **atomically** in a PATCH: a value of
`{ "$inc": n }` (or `{ "$dec": n }`) compiles to `SET col = col + n` inside
the single UPDATE statement, so concurrent writers never lose updates — no
read-modify-write:

```bash
curl -X PATCH http://localhost:3000/api/v1/data/player_stats/<id>   -H 'content-type: application/json'   -d '{ "wins": { "$inc": 1 }, "damage_dealt": { "$inc": 320.5 }, "last_room": "R1" }'
```

- Operators only apply to **numeric** columns (`integer`, `big_integer`,
  `decimal`, `float`, `percentage`, `currency`, `rating`); anywhere else is a
  `400` (`INVALID_ATOMIC_OP`).
- Negative `$inc` subtracts; `$dec: n` is sugar for `$inc: -n`. Exactly one
  operator key per value — mixed shapes are rejected.
- `json` columns are exempt: an object value there is stored as data, so a
  legal `{"$inc": 1}` JSON document is never misread as an operator.
- Field `constraints` (min/max) are not pre-checked for incremented columns —
  the generated CHECK constraints in Postgres remain the enforcement.

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
| `200` | Successful read/update (incl. an upsert that updated an existing row) |
| `201` | Record(s) created (incl. an upsert that inserted) |
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
await contacts.update(id, { wins: { $inc: 1 } });         // PATCH atomic counter add
await contacts.increment(id, { wins: 1, losses: -1 });    // same, sugared
await contacts.upsert({ device_id: 'abc' }, { onConflict: 'device_id' }); // POST ?on_conflict
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
