# @ion-drive/core

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
- Data-path correctness (#10, #11): `json` columns accept JSON objects/arrays natively on every write surface (pre-encoded strings still accepted), and Postgres constraint violations map to a stable error contract — 409 `unique_violation`/`foreign_key_violation` (with the offending `field`), 400 `not_null_violation`/`invalid_value` — instead of raw 500s with leaked SQLSTATE/constraint names.
- afd0382: Per-object public read access for anonymous requests (#8): a built-in **`public` role**, seeded empty, that the permission engine evaluates for the null (no-credential) principal.

  - Grant `read` on a named object to the `public` role (roles API or the admin Roles page) and anonymous requests can read it under `ION_REQUIRE_AUTH=true`: REST list / get-by-id / aggregate, the matching GraphQL queries, and a read-only anonymous MCP server exposing per-object-gated `query_data` / `aggregate_data` / `get_record`. Grants are strictly per-object — `expand=` targets and GraphQL relation fields are checked against the target object too.
  - Safety rails: the role can only hold `read` grants on named data objects (`*`, write/manage actions, and platform resources are 400-rejected on every mutation path, and re-filtered defensively at evaluation time); anonymous writes are always 401; the role cannot be renamed, deleted, assigned to users, or bound to API keys; admin/platform routes 401 anonymous callers before the engine is ever consulted. Public grants also union into authenticated principals' reads, so logging in never shows less than logging out.
  - New `ION_PUBLIC_ROLE` env (default `true` — inert until grants exist; set `false` to hard-disable anonymous evaluation). Docs: `docs/concepts/public-read.md` ("Public read access", leaderboard walkthrough).

- 2b3c5e4: Row-level policies: owner-scoped reads/writes per object (#7, roadmap F12 / Phase 17 — the first unfreeze). A permission grant may now carry a `rowPolicy` — `"own"` (`created_by = actor`), `"all"` (default, unchanged behavior), `"none"`, or a single-field match `{ field, equals | contains: "actor.id" }` — so the same role machinery (roles API, admin editor, public-role rails, block-installed roles) scopes **which rows** a principal touches, not just which objects.

  - Enforced once in the shared `DataService`, so REST, GraphQL (including relation fields), MCP, aggregates, search, pagination totals, and bulk operations agree: out-of-policy rows are excluded from lists/counts/aggregates, 404 on get/update/delete (exactly like missing rows), hydrate as `null` through `expand=`/GraphQL traversal, and cannot be hijacked by an upsert (the update policy becomes the `ON CONFLICT DO UPDATE`'s WHERE — a foreign conflict row is a typed `403 ROW_POLICY_DENIED`). Creates must produce a row the actor's policy matches (owner columns stamped, foreign values rejected). The realtime SSE stream and GraphQL subscriptions filter data events against the reader's row policy via the event's row image.
  - Policies union like grants: any allowing grant without a policy is unrestricted — which is the bypass (the admin role and admin-bound service keys keep full access; no new flag). Grants are validated on every role mutation path; anonymous (public-role) and guest (anonymous-role) principals participate like everyone else.
  - Wired only under `ION_REQUIRE_AUTH=true`, and no `rowPolicy` means `"all"` — zero behavior change for existing deployments. One hardening change: authenticated relation traversal into an object none of the caller's roles grant now fails closed (hydrates `null`) instead of leaking rows, matching the anonymous rule from #8.
  - New docs: `docs/concepts/row-policies.md`; design record in ADR-025 (why app-layer policies rather than native Postgres RLS). Field masking and true relation-scoped policies are explicitly deferred (Phase 17 remainder).

## 0.4.1

### Patch Changes

- Security patch: the 0.4.0 artifacts were published from a tree that predates the framework-mode security audit fixes (V1–V7). 0.4.1 ships them all: scaffolded projects enforce auth by default (`ION_REQUIRE_AUTH=true` in the generated `.env`), production boot refuses to start with auth off unless `ION_ALLOW_OPEN=true`, wildcard credentialed CORS is refused at boot, signup locks after bootstrap via `ION_DISABLE_SIGNUP` (TOCTOU-safe, enforced inside the auth router), `/metrics` can be token-protected, and boot-time advisories warn about untrusted proxies and non-production mode. Also included: `ION_REQUIRE_AUTH=false` is now honored (was silently coerced to true), agent-facing docs spell out the role-bound API key MCP needs, and the MCP server reports its real version.

## 0.4.0

### Minor Changes

- Blocks registry ecosystem (Phase 18, specs 01–08 + 10, ADR-022/ADR-023).

  Core: registry protocol v1 (Zod schemas, parsers, generated JSON Schemas at `schemas/*.v1.json`), block manifest v1 (strict semver, `dependencies` ranges, `requires.core` enforced at install), manifest diffing + `BlockEngine.upgrade`, install provenance columns (`artifact_digest`, `trust_tier`, …).

  CLI: multi-registry config + `[@ns/]name[@selector]` refs with digest verification and sigstore trust tiers (`registry list/add/remove/ping`, `block verify`), the registry generator + publishing toolchain (`registry build/yank/deprecate`, `block new/validate/pack/publish`), ephemeral-server `block test` + `audit`, `diff`/`update` with the `.new`-file convention, `search`, registry MCP server (`ion-drive mcp`), and the iondrive.dev domain unification.

  Admin and client ride along via the fixed version group.

## 0.3.0

### Minor Changes

- Storage port + first-party plugin groundwork: new `StorageProvider` port with a
  filesystem `LocalStorage` default registered under `STORAGE_SERVICE`
  (`ION_STORAGE_DIR`, default `.ion-storage/`); `recordEventPublished`/
  `recordEventDelivery` and `ION_ATTR` are now public exports so external bus
  implementations keep `ion.event.*` telemetry parity; `PluginContext.bus`
  re-resolves live so plugins loading after a bus swap see the replacement.

### Patch Changes

- @ion-drive/admin@0.3.0

## 0.2.0

### Minor Changes

- 69f7537: Phase 14 (framework mode) groundwork:

  - Core serves the built admin console SPA at `/admin` (`ION_ADMIN_ENABLED`,
    `ION_ADMIN_DIST`), with SPA fallback, cache headers, and a root redirect.
  - Hardening knobs: `ION_TRUST_PROXY` (Fastify trustProxy), `ION_METRICS_TOKEN`
    (bearer-protected `/metrics`), `ION_DISABLE_SIGNUP` (close public signup
    once the first admin exists).
  - Packages are publishable: fixed-version group (core/admin/cli/client) via
    changesets; the CLI's bundled block catalog became optional (blocks move to
    their own repos per ADR-018).

### Patch Changes

- Updated dependencies [69f7537]
  - @ion-drive/admin@0.2.0
