# GraphQL API Reference

Ion Drive serves a GraphQL endpoint at **`/api/v1/graphql`** (with the GraphQL
Yoga in-browser explorer when you open it in a browser). The schema is
**reflected from the live registry** — every non-system object contributes a
type, a list query, a by-id query, and create/update/delete mutations. When you
change the schema, the GraphQL schema is rebuilt automatically (cached by
registry version). See [ADR-009](https://github.com/jaredgrabill/ion-drive/blob/main/docs/research/architecture-decisions.md).

## Generated shape

For an object `contacts` you get:

```graphql
type Contacts { id: ID! full_name: String email: String status: String created_at: DateTime }

type ContactsListResult { data: [Contacts!]! pagination: PaginationMeta! }

type Query {
  contacts(
    filter: [FilterInput!]
    search: String
    sort: [SortInput!]
    page: Int
    pageSize: Int
  ): ContactsListResult!
  contacts_aggregate(
    fn: AggregateFunction!      # count | sum | avg | min | max
    field: String               # required for sum/avg/min/max (numeric fields)
    filter: [FilterInput!]
    search: String
  ): AggregateResult!           # { fn field value filteredCount }
  contacts_by_id(id: ID!): Contacts
}

type Mutation {
  create_contacts(input: ContactsCreateInput!): Contacts
  update_contacts(id: ID!, input: ContactsUpdateInput, increment: ContactsIncrementInput): Contacts
  upsert_contacts(input: ContactsCreateInput!, onConflict: [String!]!): ContactsUpsertResult!
  delete_contacts(id: ID!): Boolean!
}
```

Two always-present introspection fields — `ion_schema_version` and
`ion_objects` — guarantee a non-empty `Query` even before any objects exist.

## Relationship traversal (Phase 13)

Relationships appear as **nested fields** on the object types, named by their
relation keys (the same keys `expand=` takes on REST/MCP):

- **FK side** (`many_to_one` / `one_to_one` source, or the "many" side of a
  `one_to_many`): the relationship name resolves the single related record —
  `Contacts.company: Companies`.
- **Reverse side**: `<fkObject>_by_<relName>` resolves the FK-holding records —
  `Companies.contacts_by_company: [Contacts!]!` (a single record for the
  reverse of a `one_to_one`).
- **many_to_many**: the relationship name resolves the linked list from either
  side — `Contacts.tags: [Tags!]!`.

```graphql
query {
  companies(pageSize: 10) {
    data {
      name
      contacts_by_company { full_name email tags { label } }
    }
  }
}
```

Traversal is **batched**: all sibling rows' relation fields collapse into one
fetch per relation per level (the same batched queries `expand=` runs), so a
nested list is not an N+1. Because the type graph is now cyclic, queries are
capped at **12 selection levels** (introspection exempt) — deeper queries are
rejected at validation time.

many_to_many keys also get **link mutations** (idempotent junction writes,
returning the number of links actually changed):

```graphql
mutation {
  link_contacts_tags(id: "…", ids: ["…", "…"])   # → Int (added)
  unlink_contacts_tags(id: "…", ids: ["…"])       # → Int (removed)
}
```

## Subscriptions (Phase 13)

When events are enabled (`ION_EVENTS_ENABLED`, the default), the schema has a
`Subscription` type bridging the realtime feed (served over GraphQL-SSE, which
GraphiQL and graphql-sse clients speak natively):

```graphql
subscription {
  events(topics: ["data.contacts.*"]) {
    id
    topic
    occurredAt
    payload
  }
}
```

Semantics are identical to `GET /api/v1/events/stream` (see
[realtime.md](realtime.md)): topic patterns in the `topic-match` grammar
(default `data.#`), best-effort from subscribe time (a feed, not a queue), and
**per-event RBAC** — events for objects the principal cannot `read` are
silently skipped. Under enforcement, subscribing anonymously errors.

## Block action mutations (Phase 13)

Every action declared by an installed block (Phase 14) is exposed as
`Mutation.<block>_<action>(input: JSON): JSON`, running through the same
executor as REST and MCP (manifest declaration + vendored handler required,
per-action RBAC, Zod input validation, timeout, telemetry):

```graphql
mutation {
  invoicing_create_payment_link(input: { invoice_id: "…" })
}
```

Input stays a `JSON` scalar — the handler's Zod schema is the validator, and
its errors surface as GraphQL errors with `extensions.code`.

## Querying

The list query accepts the same capabilities as REST (see the
[Querying guide](querying.md)):

```graphql
query {
  contacts(
    search: "acme"
    filter: [{ field: "status", operator: neq, value: "archived" }]
    sort: [{ field: "created_at", direction: desc }]
    page: 1
    pageSize: 25
  ) {
    data { id full_name email status }
    pagination { totalCount totalPages hasNextPage }
  }
}
```

- `search: String` — free-text search across text-like columns.
- `filter: [FilterInput!]` — each `{ field, operator, value }`; `operator` is the
  `FilterOperator` enum (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`,
  `in`, `nin`, `is_null`, `is_not_null`).
- `sort: [SortInput!]` — each `{ field, direction }` with direction `asc`/`desc`.
- `page` / `pageSize` — pagination (pageSize is clamped to 100 server-side).

### Aggregates

`<object>_aggregate` computes a single `count`/`sum`/`avg`/`min`/`max` over the
rows matching the same `filter`/`search` conditions as the list query:

```graphql
query {
  players_aggregate(
    fn: avg
    field: "damage_dealt"
    filter: [{ field: "match_count", operator: gte, value: 10 }]
  ) {
    value          # null when no rows matched
    filteredCount  # the matching-row count (= the list query's totalCount)
  }
}
```

`count` needs no `field`; the others require a numeric field. See the
[Leaderboards & aggregates guide](querying.md#leaderboards--aggregates) for
the rank/percentile patterns this enables.

## Mutations

```graphql
mutation {
  create_contacts(input: { full_name: "Ada Lovelace", email: "ada@example.com" }) {
    id
    full_name
  }
}
```

`update_contacts(id, input)` performs a partial update; `delete_contacts(id)`
returns a boolean.

### Atomic increments

When an object has numeric fields, its update mutation gains an `increment`
argument (`<Object>IncrementInput` — one optional number per numeric field).
Each entry compiles to `SET field = field + amount` in the same single UPDATE
statement, so concurrent counters never lose updates (this is the typed
GraphQL face of REST's `{ "$inc": n }` operator — a literal `$inc` key is not
a legal input field name). Negative amounts subtract. `input` is optional when
`increment` exists, so a pure counter bump needs no empty object; a field may
not appear in both.

```graphql
mutation {
  update_player_stats(id: "…", increment: { wins: 1, shots_fired: 12 }) {
    wins
  }
}
```

### Upsert

`upsert_<object>(input, onConflict)` creates or updates in one atomic
statement (`INSERT … ON CONFLICT DO UPDATE`). `onConflict` must name a
**declared** unique target — a single `isUnique` field, the primary key, or a
`constraints.uniqueTogether` group (any column order). The result carries the
row plus a `created` flag (`true` = inserted, `false` = updated an existing
row).

```graphql
mutation {
  upsert_player_stats(
    input: { device_id: "abc", room_code: "R1", seed: 7 }
    onConflict: ["room_code", "seed"]
  ) {
    created
    data { id wins }
  }
}
```

## Scalars

- `DateTime` — ISO-8601 string for `date`, `datetime`, and `time` columns.
- `JSON` — arbitrary JSON for `json` columns and filter values.

## Notes

- All three data surfaces (REST, GraphQL, MCP) run through the same
  `DataService`, so behaviour — coercion, search semantics, pagination — is
  identical across them.
- The engine is graphql-js + graphql-yoga (not Pothos/Apollo): the schema shape
  is only known at runtime, so a reflected schema is a better fit than a
  compile-time builder.
