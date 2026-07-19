# Querying: search, filters, sorting, pagination

Every list endpoint in Ion Drive speaks the same query language. It is designed
to be **readable in a URL**, **easy to build by hand**, and **consistent across
REST, GraphQL, and MCP**. The `@ion-drive/client` SDK builds these queries for
you in a type-safe way.

- [Free-text search](#free-text-search)
- [Property filters & operators](#property-filters--operators)
- [Sorting](#sorting)
- [Pagination](#pagination)
- [Leaderboards & aggregates](#leaderboards--aggregates)
- [Field selection & expansion](#field-selection--expansion)
- [The client query builder](#the-client-query-builder)
- [GraphQL & MCP](#graphql--mcp)

All examples below use the REST list endpoint:

```
GET /api/v1/data/:object
```

The response is always the same envelope:

```json
{
  "data": [ /* records */ ],
  "pagination": {
    "page": 1, "pageSize": 25, "totalCount": 42,
    "totalPages": 2, "hasNextPage": true, "hasPreviousPage": false
  }
}
```

---

## Free-text search

`search` (alias `q`) matches a term against **all text-like columns** of the
object — `text`, `email`, `url`, `slug`, and single/multi `enum` fields — using a
case-insensitive `ILIKE '%term%'` OR across those columns.

```
GET /api/v1/data/contacts?search=acme
GET /api/v1/data/contacts?q=acme          # shorthand alias
```

`%` and `_` in the term are matched literally (they are escaped), so a search
for `50%` does not become a wildcard. Search combines with filters via **AND**.

---

## Property filters & operators

Filter on a specific property with the `field[operator]=value` syntax. A bare
`field=value` is shorthand for equality.

```
GET /api/v1/data/contacts?status[neq]=archived&age[gte]=21
GET /api/v1/data/contacts?status=active          # same as status[eq]=active
```

### Operators

| Operator | Meaning | Aliases | Example |
|:---|:---|:---|:---|
| `eq` | equals | `=`, `==` | `status[eq]=active` |
| `neq` | not equal | `ne`, `!=`, `<>` | `status[neq]=archived` |
| `gt` | greater than | `>` | `age[gt]=21` |
| `gte` | greater or equal | `>=` | `age[gte]=21` |
| `lt` | less than | `<` | `age[lt]=65` |
| `lte` | less or equal | `<=` | `age[lte]=64` |
| `like` | case-sensitive contains | | `name[like]=Jo` |
| `ilike` | case-insensitive contains | `contains` | `name[ilike]=jo` |
| `in` | in a comma-separated list | | `tier[in]=gold,platinum` |
| `nin` | not in a list | `notin` | `tier[nin]=free` |
| `is_null` | value is NULL | `null`, `isnull` | `deleted_at[is_null]=true` |
| `is_not_null` | value is not NULL | `notnull` | `deleted_at[is_not_null]=true` |

**Operators are case-insensitive.** `name[NEQ]=John` and `name[neq]=John` are
identical — so are the aliases: `age[GT]=30`, `age[>]=30`, and `age[gt]=30` all
mean the same thing.

### Value coercion

Values arrive as strings and are coerced automatically:

- `true` / `false` → boolean
- `null` → null
- numeric strings → number (e.g. `age[gt]=21` compares as an integer)
- everything else stays a string (dates included — Postgres compares them)

For `in`/`nin`, each comma-separated item is coerced individually:
`age[in]=18,21,30` becomes `[18, 21, 30]`.

For `is_null` / `is_not_null` the value is ignored — any placeholder works
(the SDK emits `true`).

### Multiple filters

Repeat parameters to AND several conditions together — including two conditions
on the same field to express a range:

```
GET /api/v1/data/orders?total[gte]=100&total[lte]=500&status[neq]=cancelled
```

---

## Sorting

`sort` takes a comma-separated list of fields. Prefix a field with `-` for
descending. Sort keys are applied in order (first is primary).

```
GET /api/v1/data/contacts?sort=-created_at          # newest first
GET /api/v1/data/contacts?sort=status,-created_at   # by status, then newest
```

Without `sort`, results default to `created_at` descending.

---

## Pagination

Two interchangeable interfaces:

- **Page-based** — `page` (1-based) and `pageSize`.
- **Offset-based** (Supabase/PostgREST-style) — `limit` and `offset`. When
  present these **take precedence**; the response's `page`/`pageSize` are derived
  from them so the metadata stays coherent.

`pageSize`/`limit` default to `25` and are clamped to a maximum of `100`.
`totalCount` reflects the filters **and** search, so it is safe to drive a pager
from it.

```
GET /api/v1/data/contacts?page=2&pageSize=50       # page-based
GET /api/v1/data/contacts?limit=50&offset=50       # offset-based (same window)
```

---

## Leaderboards & aggregates

The query language has no group-by or window functions — deliberately. The
standard leaderboard reads compose from two primitives you already have
(**sort + filtered `totalCount`**) plus one small aggregate endpoint.

### Top N — sort + pageSize

```
GET /api/v1/data/players?sort=-wins&pageSize=100
```

That is the leaderboard page itself (`pageSize` caps at 100; page through for
more).

### Rank — filtered totalCount

`pagination.totalCount` respects filters and search, and the list query runs a
real `COUNT(*)` under the same conditions — so a **count-where is already a
first-class, cheap read**. A player's rank is the number of players ahead of
them, plus one:

```bash
# "My rank" for a player with 42 wins: count players with more wins.
curl 'http://localhost:3000/api/v1/data/players?wins[gt]=42&pageSize=1'
# -> { "data": [ ... 1 row ... ], "pagination": { "totalCount": 1237, ... } }
# rank = totalCount + 1 = 1238
```

`pageSize=1` keeps the payload minimal — you only want the count. Ties: with
`wins[gt]=` equal scores share the best rank (standard competition ranking,
"1224"); use a tie-breaker filter (e.g. `&created_at[lt]=…`) if you need total
order.

The aggregate endpoint below returns the same number without fetching any rows
(`fn=count` → `filteredCount`), which reads more clearly:

```bash
curl 'http://localhost:3000/api/v1/data/players/aggregate?fn=count&wins[gt]=42'
# -> { "data": { "fn": "count", "field": null, "value": 1237, "filteredCount": 1237 } }
```

### Percentile — two counts

```
percentile = 100 * (1 - countAbove / countTotal)
```

`countAbove` is the rank query above; `countTotal` is the same query without
the filter (`fn=count` with no conditions).

### Aggregates — `GET /api/v1/data/:object/aggregate`

A single `count` / `sum` / `avg` / `min` / `max` over the rows matching the
**same filter + search parameters as the list endpoint** — one condition
pipeline, so an aggregate always agrees with `pagination.totalCount` for the
same query.

```
GET /api/v1/data/:object/aggregate?fn=<fn>[&field=<field>][&filters…][&search=…]
```

| Parameter | Meaning |
|:---|:---|
| `fn` | **Required.** One of `count`, `sum`, `avg`, `min`, `max`. One fn per call. |
| `field` | The field to aggregate. Required for `sum`/`avg`/`min`/`max` (numeric fields only — 400 otherwise). Optional for `count`: with a field it counts that field's **non-null** values. |
| anything else | The list endpoint's filter operators and `search`/`q`, applied identically. Sort/pagination keys are ignored (a scalar has no order or pages). |

```bash
curl 'http://localhost:3000/api/v1/data/players/aggregate?fn=avg&field=damage_dealt&match_count[gte]=10'
```

```json
{
  "data": {
    "fn": "avg",
    "field": "damage_dealt",
    "value": 1234.5,
    "filteredCount": 812
  }
}
```

- `value` is `null` when no rows match (`sum`/`avg`/`min`/`max` over an empty
  set, SQL semantics). Values are JSON numbers; astronomically large
  `BIGINT`/`NUMERIC` results (beyond 2⁵³) lose precision.
- `filteredCount` is always the matching-row count — `avg` callers get their
  denominator, rank callers their numerator, in one request.
- RBAC: same `read` permission as listing the object.

**On the other surfaces** (same shape everywhere):

```graphql
{ players_aggregate(fn: avg, field: "damage_dealt",
    filter: [{ field: "match_count", operator: gte, value: 10 }]) {
    value filteredCount } }
```

```ts
// Client SDK — aggregate() is a chain terminator like .single():
const { value } = await ion.from('players').query()
  .gte('match_count', 10)
  .aggregate('avg', 'damage_dealt');

// Rank, in one line (.count() is sugar for .aggregate('count')):
const rank = (await ion.from('players').query().gt('wins', mine).count()) + 1;
```

MCP agents get the same capability as the `aggregate_data` tool (same
`filters`/`search` shape as `query_data`).

There is deliberately no group-by, multi-fn batching, or window/rank SQL —
if you need those, reach for a SQL view or report endpoint of your own.

---

## Field selection & expansion

- `select` — comma-separated list of fields to return (projection).
- `expand` — comma-separated **relation keys** to include as attached records.

```
GET /api/v1/data/contacts?select=id,full_name,email
GET /api/v1/data/contacts?expand=company,tags
GET /api/v1/data/companies?expand=contacts_by_company
```

A relation key is (Phase 13):

| Key | Where | Attaches |
|:--|:--|:--|
| `<relName>` | the FK-holding side (`many_to_one`/`one_to_one` source, `one_to_many` target) | the related record or `null` |
| `<relName>` | either side of a `many_to_many` | the linked records (array) |
| `<fkObject>_by_<relName>` | the "one" side (reverse traversal) | the FK-holding records (array; single for a reverse `one_to_one`) |

The OpenAPI spec's `expand` parameter (and MCP's `get_object` tool) list each
object's available keys. Unknown keys are ignored. GraphQL exposes the same
keys as nested fields (see [graphql.md](graphql.md)).

---

## Writing many-to-many links (Phase 13)

FK-backed links are set through the record itself (`{ "company_id": "…" }`);
`many_to_many` links are written through the junction endpoints:

```
POST   /api/v1/data/contacts/:id/links/tags    { "ids": ["…", "…"] }   → { "data": { "added": n } }
DELETE /api/v1/data/contacts/:id/links/tags    { "ids": ["…"] }        → { "data": { "removed": n } }
```

Both are idempotent (already-linked / not-linked ids are skipped) and emit
`data.<object>.linked` / `data.<object>.unlinked` events carrying only the ids
that actually changed. SDK: `ion.from('contacts').link(id, 'tags', ids)` /
`.unlink(...)`; MCP: `link_records` / `unlink_records`; GraphQL:
`link_<object>_<rel>` / `unlink_<object>_<rel>` mutations.

---

## The client query builder

`@ion-drive/client` ships a fluent, **awaitable** builder inspired by Supabase's
postgrest-js — you never assemble these strings by hand. It normalises operator
aliases, encodes values (dates become ISO strings), and joins list values for
you. Start from `.from(object).select(...)`, chain filters/modifiers, and
`await` the chain — no terminal call needed.

```ts
import { IonDriveClient } from '@ion-drive/client';

const ion = new IonDriveClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.ION_DRIVE_API_KEY, // optional
});

const contacts = ion.from('contacts');

// Awaiting the chain executes it -> { data, pagination }
const { data, pagination } = await contacts
  .select('id, full_name, email')          // projection (optional)
  .search('acme')
  .neq('status', 'archived')
  .in('tier', ['gold', 'platinum'])
  .gte('created_at', new Date('2020-10-10'))
  .order('created_at', { ascending: false })
  .range(0, 24);                           // rows 0..24 (offset-based)

// Single-row terminals
const one  = await contacts.select().eq('id', id).single();       // throws unless exactly 1
const some = await contacts.select().eq('email', e).maybeSingle(); // T | null (throws if >1)
const rows = await contacts.select().search('acme').all();        // just the array
```

Prefer to build only the string (for a `fetch` you already own)? Use the
standalone `query()` factory:

```ts
import { query } from '@ion-drive/client';

const qs = query()
  .neq('name', 'John')
  .gt('created_at', '2020-10-10')
  .search('acme')
  .order('created_at', { ascending: false })
  .range(0, 24)
  .toQueryString();
// "name[neq]=John&created_at[gt]=2020-10-10&search=acme&sort=-created_at&offset=0&limit=25"

await fetch(`${baseUrl}/api/v1/data/contacts?${qs}`);
```

### Builder cheatsheet

| Method | Emits / does |
|:---|:---|
| `.where(field, op, value)` | `field[op]=value` (accepts aliases) |
| `.eq/.neq/.gt/.gte/.lt/.lte(field, value)` | the matching operator |
| `.like/.ilike(field, value)` | contains match |
| `.in(field, [...])` / `.nin(field, [...])` | comma-joined list |
| `.isNull(field)` / `.isNotNull(field)` / `.is(field, null)` | null checks |
| `.not(field, op, value)` | negation (`eq`→neq, `in`→nin, `is null`→is_not_null) |
| `.match({ a, b })` | one `eq` per key |
| `.search(term)` | `search=term` |
| `.order(field, { ascending })` / `.sort(field, dir)` | appends to `sort=` |
| `.limit(n)` / `.offset(n)` / `.range(from, to)` | offset-based paging |
| `.page(n)` / `.pageSize(n)` | page-based paging |
| `.expand(...rels)` / `.select(cols)` | expansion / projection |
| **`await` / `.list()`** | execute → `{ data, pagination }` |
| `.all()` / `.first()` / `.single()` / `.maybeSingle()` | execute → rows / one |
| `.aggregate(fn, field?)` | execute → `{ fn, field, value, filteredCount }` |
| `.count()` | execute → the matching-row count (number) |
| `.toQueryString()` | the raw query string (no fetch) |

---

## GraphQL & MCP

The same capabilities are exposed on the other surfaces.

**GraphQL** — the generated list query accepts `search`, `filter`, `sort`,
`page`/`pageSize`, and `limit`/`offset`:

```graphql
{
  contacts(
    search: "acme"
    filter: [{ field: "status", operator: neq, value: "archived" }]
    sort: [{ field: "created_at", direction: desc }]
    page: 1
    pageSize: 25
  ) {
    data { id full_name email }
    pagination { totalCount totalPages }
  }
}
```

**MCP** — the `query_data` tool takes `object_name`, `search`, `filters`,
`sort`, `page`/`page_size`, and `limit`/`offset`, so an LLM agent searches and
filters exactly like the REST and GraphQL clients do.
