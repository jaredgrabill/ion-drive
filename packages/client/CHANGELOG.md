# @ion-drive/client

## 0.5.0

### Minor Changes

- df9973f: Leaderboard-shaped reads (#13): a minimal aggregate surface plus the documented rank pattern.

  - New `GET /api/v1/data/:object/aggregate?fn=count|sum|avg|min|max[&field=…]` honoring the same filter + search parameters (and RBAC read permission) as the list endpoint — one shared condition pipeline, so aggregates always agree with `pagination.totalCount`. `count` needs no field (with one it counts non-null values); `sum`/`avg`/`min`/`max` require a numeric field (400 otherwise). Response: `{ "data": { "fn", "field", "value", "filteredCount" } }`. One fn per call — deliberately no group-by, multi-fn batching, or window functions.
  - Surface parity: GraphQL `<object>_aggregate(fn, field, filter, search)`, MCP `aggregate_data` tool, OpenAPI operations per object, and client SDK `.aggregate(fn, field?)` / `.count()` chain terminators.
  - `docs/api/querying.md` gains a "Leaderboards & aggregates" section documenting top-N via `sort`+`pageSize`, RANK via filtered `totalCount + 1`, and percentile from two counts.

- 977353e: Anonymous (guest) sign-in, upgradeable to a real account (#6) — Better Auth's official `anonymous` plugin, exposed through Ion Drive's adapter and config.

  - New opt-in flag `ION_ANONYMOUS_AUTH` (default OFF): mounts `POST /api/auth/sign-in/anonymous`, which mints a real user flagged `isAnonymous` (placeholder email domain derived from `ION_PUBLIC_URL`) with a session. Flag off → the endpoint 404s. `GET /api/v1/me` now reports `user.isAnonymous`.
  - New seeded **`anonymous` RBAC role**, auto-assigned to guests at creation. Ships with zero grants — admins edit it like any other role to define guest access. Guests are excluded from first-admin bootstrap accounting: a guest arriving first can neither become admin nor close the bootstrap window.
  - **Upgrade continuity**: when a guest signs up with a real credential, Better Auth creates a _new_ user and deletes the guest (its documented account-migration model — the id is not preserved). Ion Drive's `onLinkAccount` hook migrates, before the deletion: `created_by`/`updated_by` stamps on every data object, explicit role assignments (dropping `anonymous`), and API-key ownership. Event-history payloads and migration provenance deliberately keep the recorded guest id.
  - **TTL cleanup**: a seeded, disabled-by-default `anonymous-user-cleanup` scheduled task (handler `anonymous_cleanup`, `config.maxAgeDays`, default 30) deletes never-upgraded guests plus their sessions and role assignments.
  - Client SDK: minimal `ion.auth.signInAnonymously()` namespace (zero-dependency, `credentials: 'include'`, typed `AuthError` with an actionable 404 message).
  - Docs: new `docs/concepts/auth.md` (enabling, guest role, upgrade semantics and exactly what carries over, `ION_DISABLE_SIGNUP` interaction, cleanup task).

- Counter-friendly writes (#9): atomic `$inc`/`$dec` operators in updates, `POST …?on_conflict=` upsert (insert-or-update with a `created` indicator), and object-level `constraints.uniqueTogether` composite unique constraints (DDL-enforced, snapshot round-tripped) — on REST, GraphQL, MCP, OpenAPI, and the client SDK (`.increment()`, `.upsert()`).

## 0.4.1

### Patch Changes

- Security patch: the 0.4.0 artifacts were published from a tree that predates the framework-mode security audit fixes (V1–V7). 0.4.1 ships them all: scaffolded projects enforce auth by default (`ION_REQUIRE_AUTH=true` in the generated `.env`), production boot refuses to start with auth off unless `ION_ALLOW_OPEN=true`, wildcard credentialed CORS is refused at boot, signup locks after bootstrap via `ION_DISABLE_SIGNUP` (TOCTOU-safe, enforced inside the auth router), `/metrics` can be token-protected, and boot-time advisories warn about untrusted proxies and non-production mode. Also included: `ION_REQUIRE_AUTH=false` is now honored (was silently coerced to true), agent-facing docs spell out the role-bound API key MCP needs, and the MCP server reports its real version.

## 0.4.0

## 0.3.0

## 0.2.0
