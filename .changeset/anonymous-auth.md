---
'@ion-drive/core': minor
'@ion-drive/client': minor
---

Anonymous (guest) sign-in, upgradeable to a real account (#6) — Better Auth's official `anonymous` plugin, exposed through Ion Drive's adapter and config.

- New opt-in flag `ION_ANONYMOUS_AUTH` (default OFF): mounts `POST /api/auth/sign-in/anonymous`, which mints a real user flagged `isAnonymous` (placeholder email domain derived from `ION_PUBLIC_URL`) with a session. Flag off → the endpoint 404s. `GET /api/v1/me` now reports `user.isAnonymous`.
- New seeded **`anonymous` RBAC role**, auto-assigned to guests at creation. Ships with zero grants — admins edit it like any other role to define guest access. Guests are excluded from first-admin bootstrap accounting: a guest arriving first can neither become admin nor close the bootstrap window.
- **Upgrade continuity**: when a guest signs up with a real credential, Better Auth creates a *new* user and deletes the guest (its documented account-migration model — the id is not preserved). Ion Drive's `onLinkAccount` hook migrates, before the deletion: `created_by`/`updated_by` stamps on every data object, explicit role assignments (dropping `anonymous`), and API-key ownership. Event-history payloads and migration provenance deliberately keep the recorded guest id.
- **TTL cleanup**: a seeded, disabled-by-default `anonymous-user-cleanup` scheduled task (handler `anonymous_cleanup`, `config.maxAgeDays`, default 30) deletes never-upgraded guests plus their sessions and role assignments.
- Client SDK: minimal `ion.auth.signInAnonymously()` namespace (zero-dependency, `credentials: 'include'`, typed `AuthError` with an actionable 404 message).
- Docs: new `docs/concepts/auth.md` (enabling, guest role, upgrade semantics and exactly what carries over, `ION_DISABLE_SIGNUP` interaction, cleanup task).
