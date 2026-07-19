# Data Objects

A **data object** is Ion Drive's core primitive: a table you define at runtime,
plus the metadata that makes it self-describing. Creating one instantly lights
up REST, GraphQL, and MCP endpoints for it — no migrations, no redeploys.

## Two layers of tables

Ion Drive keeps its own metadata separate from your data:

- **User data objects** — the tables you create (`contacts`, `invoices`, …).
- **System tables** — Ion Drive's own metadata, prefixed `_ion_`
  (`_ion_objects`, `_ion_fields`, `_ion_relationships`, `_ion_migrations`, and
  the auth/secrets/tasks/blocks tables). These are hidden from the data API.

Don't confuse the two: system tables describe the platform; data objects hold
your application's data.

## Anatomy of an object

```jsonc
{
  "name": "contacts",           // lowercase, snake_case — the API path segment
  "displayName": "Contacts",    // human label
  "description": "People we work with",
  "fields": [
    { "name": "full_name", "displayName": "Full Name", "columnType": "text", "isRequired": true },
    { "name": "email",     "displayName": "Email",     "columnType": "email", "isUnique": true },
    { "name": "status",    "displayName": "Status",    "columnType": "enum",
      "constraints": { "enumValues": ["active", "archived", "pending"] }, "defaultValue": "active" }
  ]
}
```

Every object automatically gets three **system fields**: `id` (UUID primary
key), `created_at`, and `updated_at`. You never define these yourself.

## Field options

| Option | Meaning |
|:---|:---|
| `columnType` | One of the built-in [column types](#column-types). |
| `isRequired` | `NOT NULL`. |
| `isUnique` | Adds a unique constraint. |
| `isIndexed` | Creates an index (also automatic for FKs and unique fields). |
| `defaultValue` | SQL default (literals are quoted for you; expressions pass through). |
| `constraints` | `min`, `max`, `pattern`, `enumValues`, `message`. |

## Column types

Column types are grouped by category. **Text-category** types (and enums) are
what free-text [search](../api/querying.md#free-text-search) matches against.

| Category | Types |
|:---|:---|
| Text | `text`, `short_text`, `long_text`, `rich_text`, `email`, `url`, `phone`, `slug` |
| Number | `integer`, `big_integer`, `decimal`, `float`, `percentage`, `currency` |
| Boolean | `boolean` |
| Date/time | `date`, `datetime`, `time` |
| Identity | `uuid`, `auto_increment` |
| Structured | `json`, `array_text`, `array_integer` |
| Enum | `enum` (single select), `multi_enum` (multi select) |
| Special | `rating`, `color`, `ip_address` |

Get the live list any time via the MCP `list_column_types` tool or the
`COLUMN_TYPES` export from `@ion-drive/core`.

`json` fields accept any JSON value on write — send the object or array
itself in the request body (no pre-encoding), and reads return the same
parsed value. A pre-encoded JSON string is also accepted for compatibility.

## Relationships

Objects can relate via `one_to_one`, `one_to_many`, `many_to_one`, and
`many_to_many` (junction tables are created automatically). Related records
are readable from **both sides** via relation keys — `expand=` on REST/MCP and
nested fields on GraphQL (see the [querying guide](../api/querying.md)); m2m
links are written through the link endpoints/mutations (Phase 13).

Relationships can also be **removed** (Phase 13): the same preview-first
contract as field changes — `DELETE
/api/v1/schema/objects/:name/relationships/:relName?dryRun=true` returns the
exact SQL and data-loss warnings (the FK column's stored links, or the
junction table's counted rows), block-owned relationships require
`?force=true`, and `ion-drive schema push --prune` removes relationships
absent from the snapshot through the same pipeline. There is deliberately
**no automated migration rollback** (`_ion_migrations.sql_down` is advisory
documentation; ADR-020) — recovery is declarative (snapshot pull/diff/push)
plus database backups.

## Lifecycle & safety

Every schema mutation runs the same pipeline:

1. **Build a ChangeSet** describing the operation.
2. **Validate** it — the `ChangeValidator`/`impact-analyzer` flags data loss,
   broken foreign keys, and constraint violations.
3. **Preview** — a human-readable diff and the exact SQL (also available via the
   admin console and the MCP `ion_schema_preview` capability).
4. **Execute** the DDL transactionally, record metadata, and bump the registry
   version so all API surfaces refresh.

Destructive changes (dropping a column or object with data) produce warnings you
must acknowledge.

## Managing objects

- **Admin console:** the visual Object Designer.
- **REST:** `POST /api/v1/schema/objects`, and the schema routes under
  `/api/v1/schema`.
- **MCP:** `create_object`, `add_field`, `delete_object`, `get_object`.
- **Building blocks:** ship a whole set of objects at once — see
  [Building Blocks](building-blocks.md).
