# @ion-drive/core

## 0.7.0

### Minor Changes

- a289e5e: Admin bootstrap first-login "claim" flow (issue #32). The env-var admin bootstrap (`ION_ADMIN_EMAIL`/`ION_ADMIN_PASSWORD`, issue #26) now marks the account it creates **pending-claim** — a durable, service-only `_ion_config` row keyed to the user id, not reachable through the dynamic data API and refused by the generic admin config route. The admin console (`packages/admin`) routes a pending-claim session to a one-time onboarding screen for every route until it completes; no other admin surface is reachable first. Submitting sets a real display name and rotates the password via a new `POST /api/v1/admin-claim` endpoint (target is always the caller's own authenticated session — never a request body field), clearing the marker atomically inside a Postgres-advisory-locked transaction so two concurrent claims can never both succeed. After claiming, the original `ION_ADMIN_PASSWORD` no longer authenticates; a second boot with the vars still set stays a no-op.

  The gate is a human-admin-UI concern only: it is not part of the RBAC enforcement hook, so API-key access and the REST/GraphQL/MCP surfaces are never gated by claim state — a pending-claim admin's own session (and any API key bound to it) keeps working exactly as before.

  Follow-up (deferred, tracked in #32): an email-only bootstrap-input mode using a one-time token printed to logs, as an alternative to the env-password mode this PR implements.

## 0.6.0

### Minor Changes

- cc5af94: Env-var admin bootstrap (issue #26). Set `ION_ADMIN_EMAIL` +
  `ION_ADMIN_PASSWORD` (or `ION_ADMIN_PASSWORD_FILE`, whose contents are read
  and trimmed — for secret mounts) and a fresh database gets its admin account
  created **at boot**, through the normal Better Auth signup path (same hashing,
  same password policy — a too-weak password fails the boot with a clear error;
  the value is never logged), with the admin role granted exactly like
  first-signup does today. The bootstrap runs before the server listens, so no
  external request can race the zero-users check.

  While the variables are set, `ION_DISABLE_SIGNUP` **defaults to `true`**: the
  server comes up locked with a working admin in one step (an explicit
  `ION_DISABLE_SIGNUP=false` keeps signup open). On a database that already has
  credentialed users the variables are ignored with a single info line, so they
  are safe to leave set permanently. Without the variables, first-signup-wins is
  unchanged. Partial configuration (email without a password source, both
  password sources, unreadable/empty password file) refuses to boot with a
  message naming the variable.

- d1cf26e: Bearer-token session verification (issue #24): Better Auth's `bearer` plugin
  is now always mounted, so the `token` returned by sign-in endpoints (including
  `POST /api/auth/sign-in/anonymous`) verifies via `Authorization: Bearer
<token>` — on `/api/auth/*` and on Ion Drive's own session resolution
  (`request.auth`, `GET /api/v1/me`). Bearer-presented sessions resolve the same
  identity and roles as cookie sessions, letting a third-party server (e.g. a
  Cloudflare Worker) verify a browser-held session it cannot read the HttpOnly
  cookie of. API keys are unaffected: `Bearer iond_…` is still routed to the
  API-key path by prefix.
- 2cc7d16: Strict boolean env-var parsing (issue #25). Every `ION_*` boolean flag now goes
  through one shared `envBool` schema: `true`/`1`/`yes`/`on` enable,
  `false`/`0`/`no`/`off` (or an empty value) disable, case-insensitive and
  trimmed. Any other value refuses to boot with an error naming the variable and
  the accepted spellings. Unset variables keep their existing defaults. The
  parser is exported (`envBool`, `parseEnvBool`) for plugin authors, and the
  first-party Redis (`ION_REDIS_BUS`) and S3 (`ION_S3_FORCE_PATH_STYLE`) plugins
  now reject unrecognised spellings the same way.

  **Behavior change — check your deployments.** `ION_OTEL_ENABLED`,
  `ION_OTEL_LOGS_ENABLED`, and `ION_OTEL_METRICS_ENABLED` previously used
  `z.coerce.boolean`, which treats **every non-empty string as true**: a
  deployment that set `ION_OTEL_ENABLED=false` was actually running with
  telemetry export **enabled** (and spamming `ECONNREFUSED` without a local
  collector). With this release such values now mean what they say, so those
  deployments will see telemetry genuinely switch off. Deployments that set any
  boolean flag to an unrecognised value (e.g. `ION_TASKS_ENABLED=enabled`) will
  now fail to boot with a clear message instead of silently misreading the flag —
  fix the value or unset the variable. `ION_S3_FORCE_PATH_STYLE` set to an empty
  string now means `false` (previously it fell back to the endpoint-derived
  default); unset is unchanged.

### Patch Changes

- 500dcf1: QA follow-ups from the Gravity Well dogfood sprint (issue #23):

  - GraphQL CRUD resolvers now surface `DataServiceError`s as typed GraphQL
    errors (`extensions.code` + the service's message and `field`) instead of a
    masked INTERNAL_SERVER_ERROR — e.g. upsert's `INVALID_CONFLICT_TARGET` and
    translated 409 `unique_violation`s.
  - Re-applying a `uniqueTogether` group whose physical `ion_uq_*` constraint
    exists but was lost from metadata (drift) now returns a 409
    `already_exists` naming the constraint, instead of a raw Postgres 42P07 500.
  - `$inc`/`$dec` aimed at system columns (`id`, `created_*`, `updated_*`) or
    unknown columns is now a 400 `INVALID_ATOMIC_OP` instead of a silent no-op.
  - `PATCH /api/v1/roles/:id` with a permissions-only body no longer wipes the
    role's description (partial-update semantics; explicit `null` still clears).
  - The intentionally-corrupt sigstore fixtures are marked `-text` in
    `.gitattributes` so EOL normalization can never invalidate their byte-exact
    SHA256 assertions.
  - Docs: `-g`/`--globoff` note for curl's bracket globbing (querying + REST),
    the node-SDK no-cookie-jar caveat, and the row-policy `contains` planting
    consequence (plus a code comment on why the reassignment guard excludes
    `contains`).

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
