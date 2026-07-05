# GraphQL API Reference

Ion Drive serves a GraphQL endpoint at **`/api/v1/graphql`** (with the GraphQL
Yoga in-browser explorer when you open it in a browser). The schema is
**reflected from the live registry** — every non-system object contributes a
type, a list query, a by-id query, and create/update/delete mutations. When you
change the schema, the GraphQL schema is rebuilt automatically (cached by
registry version). See [ADR-009](../research/architecture-decisions.md).

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
  contacts_by_id(id: ID!): Contacts
}

type Mutation {
  create_contacts(input: ContactsCreateInput!): Contacts
  update_contacts(id: ID!, input: ContactsUpdateInput!): Contacts
  delete_contacts(id: ID!): Boolean!
}
```

Two always-present introspection fields — `ion_schema_version` and
`ion_objects` — guarantee a non-empty `Query` even before any objects exist.

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
