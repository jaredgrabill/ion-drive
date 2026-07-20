# @ion-drive/admin

## 0.7.0

### Minor Changes

- a289e5e: Admin bootstrap first-login "claim" flow (issue #32). The env-var admin bootstrap (`ION_ADMIN_EMAIL`/`ION_ADMIN_PASSWORD`, issue #26) now marks the account it creates **pending-claim** — a durable, service-only `_ion_config` row keyed to the user id, not reachable through the dynamic data API and refused by the generic admin config route. The admin console (`packages/admin`) routes a pending-claim session to a one-time onboarding screen for every route until it completes; no other admin surface is reachable first. Submitting sets a real display name and rotates the password via a new `POST /api/v1/admin-claim` endpoint (target is always the caller's own authenticated session — never a request body field), clearing the marker atomically inside a Postgres-advisory-locked transaction so two concurrent claims can never both succeed. After claiming, the original `ION_ADMIN_PASSWORD` no longer authenticates; a second boot with the vars still set stays a no-op.

  The gate is a human-admin-UI concern only: it is not part of the RBAC enforcement hook, so API-key access and the REST/GraphQL/MCP surfaces are never gated by claim state — a pending-claim admin's own session (and any API key bound to it) keeps working exactly as before.

  Follow-up (deferred, tracked in #32): an email-only bootstrap-input mode using a one-time token printed to logs, as an alternative to the env-password mode this PR implements.

## 0.6.0

## 0.5.0

## 0.4.1

### Patch Changes

- Security patch: the 0.4.0 artifacts were published from a tree that predates the framework-mode security audit fixes (V1–V7). 0.4.1 ships them all: scaffolded projects enforce auth by default (`ION_REQUIRE_AUTH=true` in the generated `.env`), production boot refuses to start with auth off unless `ION_ALLOW_OPEN=true`, wildcard credentialed CORS is refused at boot, signup locks after bootstrap via `ION_DISABLE_SIGNUP` (TOCTOU-safe, enforced inside the auth router), `/metrics` can be token-protected, and boot-time advisories warn about untrusted proxies and non-production mode. Also included: `ION_REQUIRE_AUTH=false` is now honored (was silently coerced to true), agent-facing docs spell out the role-bound API key MCP needs, and the MCP server reports its real version.

## 0.4.0

## 0.3.0

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
