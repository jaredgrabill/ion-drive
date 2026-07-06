---
name: surface-parity
description: Checklist for adding or changing any data-layer capability (query param, field option, CRUD behavior) so REST, OpenAPI, GraphQL, MCP, the client SDK, docs, and the admin move in lockstep.
---

# Surface parity checklist

Ion Drive's #1 convention (`CLAUDE.md`): a capability added to one surface must be reflected
in all of them. Work through this list **in order** — engine first, consumers after.

## Cautionary tale

Phase 10's `expand=` was parsed by the query layer but shipped **implemented on REST only**.
MCP had to be retrofitted with `expand` params on `query_data`/`get_record`, and GraphQL
*still* has no relationship traversal (roadmap F6, slated for Phase 13). Every skipped row
below becomes a roadmap finding later. Don't skip rows — if a surface deliberately won't get
the capability, say so explicitly in your summary and add it to `docs/roadmap.md`.

## The checklist

1. **Engine** — `packages/core/src/data/query-parser.ts` (parse/validate the new param) and
   `packages/core/src/data/data-service.ts` (execute it). Shared helpers matter:
   filters+search flow through `DataService.applyConditions` (used by both the data and count
   queries), pagination through `DataService.resolveWindow`. Types in
   `packages/core/src/data/types.ts`.
2. **REST** — `packages/core/src/api/data-routes.ts`. Usually free if the query-parser reads
   it from the querystring, but check error mapping and response envelope.
3. **OpenAPI** — `packages/core/src/api/openapi-routes.ts`. Add the parameter/schema so
   `/api/v1/openapi.json` documents it (this spec is what external agents read).
4. **GraphQL** — `packages/core/src/api/graphql/schema-builder.ts` (args/types) and
   `packages/core/src/api/graphql/resolver-factory.ts` (map args → `DataService` options).
   Custom scalars live in `scalars.ts`; yoga wiring in `plugin.ts`.
5. **MCP** — `packages/core/src/mcp/server.ts`. Add the Zod input param **and a
   plain-language description** to the affected tools (`query_data`, `get_record`,
   `create_record`, `update_record`, `delete_record`, schema tools). MCP is a first-class
   surface; agent-facing descriptions are part of the feature.
6. **Client SDK** — `packages/client/src/query-builder.ts` (chainable method →
   `URLSearchParams`) and `packages/client/src/client.ts` (`Resource`/`ResourceQuery` if the
   capability affects reads/writes rather than query params). Types are re-declared in
   `packages/client/src/types.ts` (never imported from core — the SDK is a leaf package).
7. **Docs** — `docs/api/querying.md` (the canonical query-language reference), plus
   `docs/api/rest.md`, `docs/api/graphql.md`, `docs/api/mcp.md` for surface-specific notes.
8. **Tests in each layer you touched**:
   - `packages/core/src/data/query-parser.test.ts`, `data-service.test.ts`
   - `packages/core/src/api/data-routes.test.ts`
   - `packages/core/src/api/graphql/schema-builder.test.ts`
   - `packages/client/src/query-builder.test.ts`, `client.test.ts`
9. **Admin console, if user-facing** — `packages/admin/src/components/data/`:
   `filter-builder.tsx` (new operators), `sort-builder.tsx`, `grid-toolbar.tsx` (search/
   pagination), `grid-cell-editor.tsx` / `record-sheet.tsx` (field-option behavior).

## Definition of done

- The same request expressed on REST, GraphQL, and MCP returns consistent results, and
  `/api/v1/openapi.json` documents it.
- The client SDK can express it without falling back to raw query strings.
- `docs/api/querying.md` describes it once; surface docs cross-reference.
- `pnpm test` and `pnpm typecheck` pass at the repo root.
- Any surface you intentionally excluded is recorded in `docs/roadmap.md` with a reason.
