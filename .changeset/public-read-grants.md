---
'@ion-drive/core': minor
---

Per-object public read access for anonymous requests (#8): a built-in **`public` role**, seeded empty, that the permission engine evaluates for the null (no-credential) principal.

- Grant `read` on a named object to the `public` role (roles API or the admin Roles page) and anonymous requests can read it under `ION_REQUIRE_AUTH=true`: REST list / get-by-id / aggregate, the matching GraphQL queries, and a read-only anonymous MCP server exposing per-object-gated `query_data` / `aggregate_data` / `get_record`. Grants are strictly per-object — `expand=` targets and GraphQL relation fields are checked against the target object too.
- Safety rails: the role can only hold `read` grants on named data objects (`*`, write/manage actions, and platform resources are 400-rejected on every mutation path, and re-filtered defensively at evaluation time); anonymous writes are always 401; the role cannot be renamed, deleted, assigned to users, or bound to API keys; admin/platform routes 401 anonymous callers before the engine is ever consulted. Public grants also union into authenticated principals' reads, so logging in never shows less than logging out.
- New `ION_PUBLIC_ROLE` env (default `true` — inert until grants exist; set `false` to hard-disable anonymous evaluation). Docs: `docs/concepts/public-read.md` ("Public read access", leaderboard walkthrough).
