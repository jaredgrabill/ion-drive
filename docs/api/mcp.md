# MCP Server

Ion Drive's Model Context Protocol server is a **first-class citizen**: any
MCP-compatible LLM agent can introspect your schema and CRUD your data with zero
integration code. It is served over stateless **Streamable HTTP** at
**`/api/v1/mcp`**, backed by the same `DataService` as the REST and GraphQL
surfaces.

## Connecting

Point an MCP client at `http://localhost:3000/api/v1/mcp`. In a client config
(e.g. Claude Desktop / Claude Code) this is an HTTP MCP server entry. When
`ION_REQUIRE_AUTH` is enabled (the scaffold default), include an API key header
(`X-API-Key: iond_…`) — and mint that key **with a role assigned** (admin
console → API Keys → pick a role such as `admin`): a key with no role has no
permissions, and the MCP surface requires `manage` on `data`.

```bash
# Claude Code, for example:
claude mcp add --transport http ion-drive http://localhost:3000/api/v1/mcp \
  --header "X-API-Key: iond_…"
```

Anonymous clients (no key at all) are refused — unless specific objects have
been granted to the built-in `public` role, in which case they get a stripped
read-only server (`query_data` / `aggregate_data` / `get_record`, gated per
object). See [Public read access](../concepts/public-read.md).

## Tools

### Schema

| Tool | Description |
|:---|:---|
| `list_objects` | List all data objects with field counts and descriptions. |
| `get_object` | Full definition of one object (fields, types, constraints). |
| `list_column_types` | All available column types with their Postgres mappings. |
| `create_object` | Create a new object (system fields added automatically; `unique_together` declares composite unique groups). |
| `add_field` | Add a field (column) to an existing object. |
| `set_unique_together` | Replace an object's composite unique groups (declarative; pre-checks live data; `dry_run`/`force`). |
| `delete_object` | Delete an object and its table (**destroys data**). |

### Data

| Tool | Description |
|:---|:---|
| `query_data` | List records with `search`, `filters`, `sort`, pagination, and `expand`. |
| `aggregate_data` | A single `count`/`sum`/`avg`/`min`/`max` over the filtered rows (same `filters`/`search` as `query_data`; rank = `filteredCount + 1` when filtering on the score being beaten). |
| `get_record` | Fetch a single record by id, optionally with `expand`. |
| `create_record` | Create a record. |
| `update_record` | Update a record by id. `increment: { field: amount }` performs atomic counter adds (`SET field = field + n`, concurrency-safe). |
| `upsert_record` | Create-or-update in one atomic statement (`on_conflict` names a declared unique target); returns the row plus `created`. |
| `delete_record` | Delete a record by id. |

`query_data` mirrors the REST/GraphQL query language:

```jsonc
{
  "object_name": "contacts",
  "search": "acme",                    // free-text across text-like columns
  "filters": [
    { "field": "status", "operator": "neq", "value": "archived" }
  ],
  "sort": [ { "field": "created_at", "direction": "desc" } ],
  "page": 1,
  "page_size": 25,
  "expand": ["company"]                // relationship names to expand (see get_object)
}
```

`expand` (also on `get_record`) attaches related records under each
relationship name, exactly like REST's `?expand=` parameter. Valid values are
the relationship names defined on the object — `get_object` lists them.

## Resources

- `ion-drive://schema/overview` — a JSON summary of every object and its fields,
  ideal as context for a model before it starts working.

## Prompts

- `explore-schema` — summarise all objects and relationships.
- `design-object` — help design a new object from a plain-language description,
  then call `create_object` with the result.

## Why MCP is first-class

Ion Drive is built for backend developers working with agentic LLMs. Because the
same object definitions drive REST, GraphQL, **and** MCP, an agent that can talk
MCP gets the identical query semantics — search, operators, coercion,
pagination — that your application code uses. Keep the surfaces in lockstep: a
capability added to one should be reflected in the others.
