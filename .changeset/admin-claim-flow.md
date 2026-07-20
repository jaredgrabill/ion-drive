---
"@ion-drive/core": minor
"@ion-drive/admin": minor
---

Admin bootstrap first-login "claim" flow (issue #32). The env-var admin bootstrap (`ION_ADMIN_EMAIL`/`ION_ADMIN_PASSWORD`, issue #26) now marks the account it creates **pending-claim** — a durable, service-only `_ion_config` row keyed to the user id, not reachable through the dynamic data API and refused by the generic admin config route. The admin console (`packages/admin`) routes a pending-claim session to a one-time onboarding screen for every route until it completes; no other admin surface is reachable first. Submitting sets a real display name and rotates the password via a new `POST /api/v1/admin-claim` endpoint (target is always the caller's own authenticated session — never a request body field), clearing the marker atomically inside a Postgres-advisory-locked transaction so two concurrent claims can never both succeed. After claiming, the original `ION_ADMIN_PASSWORD` no longer authenticates; a second boot with the vars still set stays a no-op.

The gate is a human-admin-UI concern only: it is not part of the RBAC enforcement hook, so API-key access and the REST/GraphQL/MCP surfaces are never gated by claim state — a pending-claim admin's own session (and any API key bound to it) keeps working exactly as before.

Follow-up (deferred, tracked in #32): an email-only bootstrap-input mode using a one-time token printed to logs, as an alternative to the env-password mode this PR implements.
