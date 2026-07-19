---
'@ion-drive/core': minor
'@ion-drive/client': minor
---

Leaderboard-shaped reads (#13): a minimal aggregate surface plus the documented rank pattern.

- New `GET /api/v1/data/:object/aggregate?fn=count|sum|avg|min|max[&field=…]` honoring the same filter + search parameters (and RBAC read permission) as the list endpoint — one shared condition pipeline, so aggregates always agree with `pagination.totalCount`. `count` needs no field (with one it counts non-null values); `sum`/`avg`/`min`/`max` require a numeric field (400 otherwise). Response: `{ "data": { "fn", "field", "value", "filteredCount" } }`. One fn per call — deliberately no group-by, multi-fn batching, or window functions.
- Surface parity: GraphQL `<object>_aggregate(fn, field, filter, search)`, MCP `aggregate_data` tool, OpenAPI operations per object, and client SDK `.aggregate(fn, field?)` / `.count()` chain terminators.
- `docs/api/querying.md` gains a "Leaderboards & aggregates" section documenting top-N via `sort`+`pageSize`, RANK via filtered `totalCount + 1`, and percentile from two counts.
