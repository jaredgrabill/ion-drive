# Public read access

Some data is meant for everyone — a game leaderboard, a public event schedule, a
product catalog. Shipping a credential in a browser bundle is not an option
(any key in a web bundle is public the moment it ships, and revoking it punishes
every visitor at once), and turning enforcement off (`ION_REQUIRE_AUTH=false`)
opens *everything*.

Ion Drive solves this with a built-in **`public` role**: a normal RBAC role that
the permission engine evaluates for the **anonymous principal** — requests that
present no credential at all. Grant `read` on a specific object to it and that
object becomes world-readable; everything else stays locked down.

Not to be confused with the `anonymous` role from
[anonymous (guest) sign-in](auth.md): guests hold a real session and evaluate
as authenticated principals through their assigned roles (writes included, if
granted); the `public` role covers requests with **no credential at all** and
is read-only by construction.

## The leaderboard example

Say your game stores scores in a `player_stats` object. Make the leaderboard
public by granting `read` on it to the `public` role — in the admin console
(**Access → Roles → public**) or through the roles API:

```bash
# Find the public role's id (as an admin)
curl -H "X-API-Key: iond_…" http://localhost:3000/api/v1/roles

# Grant read on player_stats to it
curl -X PATCH -H "X-API-Key: iond_…" -H "content-type: application/json" \
  -d '{"permissions":[{"resource":"player_stats","actions":["read"]}]}' \
  http://localhost:3000/api/v1/roles/<public-role-id>
```

From that moment, a browser can read the leaderboard with **zero credentials**:

```bash
# Top 100 by wins — no API key, no cookie
curl "http://localhost:3000/api/v1/data/player_stats?sort=-wins&pageSize=100"

# A player's rank, without fetching rows (the documented rank pattern)
curl "http://localhost:3000/api/v1/data/player_stats/aggregate?fn=count&wins[gt]=42"
```

## What a public grant covers

A `read` grant to the `public` role opens the **read surfaces only**, and only
for the named object:

- **REST** — list, get-by-id, and aggregate on `/api/v1/data/<object>`.
- **GraphQL** — the object's list / `_by_id` / `_aggregate` queries. Ungranted
  objects (and all mutations) still error for anonymous callers.
- **MCP** — anonymous clients get a read-only server exposing just
  `query_data`, `aggregate_data`, and `get_record`, each checked per object.
  Schema tools, action tools, resources, and prompts are not even listed.

Public grants are **strictly per-object, including relations**: an anonymous
`expand=` (REST/MCP) or a nested relation field (GraphQL) is honored only when
the *target* object is also granted to the public role. Note that anonymous
GraphQL callers can introspect the schema's type names (not data) — the same
information the OpenAPI document already exposes.

## What it can never cover

The role is fenced by validation rails enforced server-side:

- It can hold **only `read` grants on named data objects** — attempts to grant
  `create`/`update`/`delete`/`manage`, the `*` wildcard, or a platform resource
  (`schema`, `secrets`, `roles`, …) are rejected with a 400. The permission
  engine additionally re-filters grants at evaluation time, so even a database
  row edited out-of-band cannot open a write.
- Anonymous **writes are always 401**, regardless of grants — the engine denies
  every non-`read` action for the null principal before any grant is consulted.
- Admin and platform routes 401 anonymous requests **before** consulting the
  permission engine, so the public role can never satisfy them.
- It **cannot be renamed, deleted, assigned to a user, or bound to an API
  key** — it exists only as the anonymous principal's grant set.
- Public grants also apply to authenticated callers (for reads), so logging in
  never shows *less* than logging out.

## Posture and knobs

- The role ships **empty**, so nothing is publicly readable until an admin
  grants it — seeding it adds no exposure.
- `ION_PUBLIC_ROLE=false` hard-disables anonymous evaluation even when grants
  exist (default: `true`).
- Anonymous traffic is covered by the standard per-IP
  [rate limiting](../deployment/security-checklist.md) (`ION_RATE_LIMIT_*`,
  on by default) — the same global bucket authenticated requests use.
- Public rows are returned whole (all columns). Don't put secrets in columns of
  a publicly granted object; column masking is a separate, planned feature.
- A public grant may carry a [row policy](row-policies.md) to scope *which*
  rows are world-readable (anonymous callers have no actor, so actor-bound
  policies like `"own"` match nothing for them — use those on authenticated
  roles).
- The realtime feed (`/api/v1/events/stream`, GraphQL subscriptions) stays
  credentialed — public grants do not extend to event streams.
