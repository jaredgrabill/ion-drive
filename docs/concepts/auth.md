# Authentication & guest users

Ion Drive's default auth is [Better Auth](https://better-auth.com) behind a
pluggable provider interface: cookie sessions via `/api/auth/*`
(email/password), role-bound API keys (`X-API-Key: iond_…`), and RBAC roles
with per-resource permission grants. The **first user to sign up becomes
admin**; further users get no roles until an admin grants them. This page
covers how the admin account is bootstrapped, and the one auth flow that is a
product feature in its own right: **anonymous (guest) sign-in with an upgrade
path to a real account**.

## Bootstrapping the admin account

There are two ways a fresh deployment gets its first admin:

**Environment bootstrap (recommended for anything public).** Set

```bash
ION_ADMIN_EMAIL=you@example.com
ION_ADMIN_PASSWORD=a-strong-password
# or, for Docker/Kubernetes secret mounts (file contents, trimmed):
ION_ADMIN_PASSWORD_FILE=/run/secrets/ion-admin-password
```

On a database with **zero credentialed users**, boot creates that account
through the normal Better Auth signup path — same password hashing, same
password policy (a too-weak password fails the boot with a clear error, the
value is never logged) — and the account receives the admin role exactly as a
first signup would. Because the bootstrap runs inside server assembly,
*before* the HTTP listener starts, no outside request can race it.

With the variables set, `ION_DISABLE_SIGNUP` **defaults to `true`**: the
server comes up with a working admin and public signup already locked, in one
step. An explicit `ION_DISABLE_SIGNUP=false` keeps signup open if that is
really what you want. On a database that already has users the variables are
ignored (one info line), so they are safe to leave set permanently — and a
guest-only database (only `isAnonymous` users) still counts as fresh, since
nobody credentialed can get in otherwise. Setting only one half of the pair
(email without a password source, or vice versa) is a boot error rather than a
silent fallback.

**First-signup-wins (the default without the variables).** The **first user to
sign up becomes admin**. This remains unchanged as the local-development path —
but on a public deployment it leaves a window between boot and your signup
where anyone who finds the URL becomes admin, and locking signup afterwards
(`ION_DISABLE_SIGNUP=true`) is a second step that is easy to forget. Prefer
the environment bootstrap for anything reachable by others.

## Why anonymous auth

Play-first / try-first apps (games, consumer trials) need a visitor to start
using the app — and accumulate real data — before creating an account, then
attach an email later and keep everything. That's Supabase's
`signInAnonymously()` → `linkIdentity()` pattern; Ion Drive exposes the
equivalent through Better Auth's official `anonymous` plugin.

## Enabling it

Anonymous sign-in is **off by default** — letting unauthenticated visitors
mint users (each with a session row and a role assignment) is a security
posture change, so it's an explicit opt-in:

```bash
ION_ANONYMOUS_AUTH=true
```

With the flag on, the server boot migration adds the plugin's `isAnonymous`
column to the user table (same programmatic migration runner as every other
Better Auth table) and mounts:

```
POST /api/auth/sign-in/anonymous
```

The response sets a normal session cookie and returns `{ token, user }` — the
guest is a **real user** with a real id, flagged `isAnonymous: true` and given
a placeholder email `temp-<id>@<host of ION_PUBLIC_URL>`.

With the flag off the endpoint 404s (the plugin is simply not mounted).

Client SDK:

```ts
const ion = new IonDriveClient({ baseUrl });
const { user } = await ion.auth.signInAnonymously();
// The session cookie now authenticates subsequent requests.
```

`GET /api/v1/me` reports `user.isAnonymous` so apps (and the admin console)
can tell guests from registered users.

## What guests may do: the `anonymous` role

Every guest is auto-assigned the seeded **`anonymous`** role at creation. It
starts with **no permission grants** — under `ION_REQUIRE_AUTH=true` a fresh
guest can authenticate but not read or write anything. Edit the role like any
other (admin console → Roles, or `PATCH /api/v1/roles/:id`) to define exactly
what guests may touch, e.g.:

```json
{ "permissions": [{ "resource": "scores", "actions": ["create", "read"] }] }
```

Grants on the anonymous role (like any role) may carry a
[row policy](row-policies.md) — `"rowPolicy": "own"` above would let each
guest read and write only the score rows they created.

Guests are excluded from the first-admin bootstrap: a guest arriving before
your first real sign-up neither becomes admin nor closes the bootstrap window.

## Upgrading a guest to a real account

While holding an anonymous session, sign up normally (email/password today;
any Better Auth credential flow the server has enabled):

```
POST /api/auth/sign-up/email   (with the guest's session cookie)
```

**Semantics — read this carefully.** Better Auth's anonymous plugin upgrades
by *account migration*, not id preservation: the sign-up creates a **new user
id**, fires the plugin's `onLinkAccount` hook, and then deletes the anonymous
user. Inside that hook — i.e. before anything is deleted — Ion Drive migrates
everything the platform keys on the user id to the new account:

| Carried over | How |
| --- | --- |
| Data rows the guest created/updated | `created_by` / `updated_by` stamps on **every data object** are re-stamped to the new id |
| Explicit role grants | `_ion_user_roles` assignments move (the `anonymous` role itself is dropped) |
| API keys bound to the guest | `_ion_api_keys.user_id` is re-pointed |

Not carried over (deliberately):

- **The user id itself.** If your app stores the guest's id in its own
  columns beyond the platform's `*_by` stamps, key those columns on rows the
  platform knows about — or re-read the id after upgrade (`/api/v1/me`).
- **Published event history.** `_ion_events` payload snapshots (and the audit
  block's rows derived from them) keep the guest id they were recorded with —
  the outbox is an immutable history.
- **Migration provenance** (`_ion_migrations.applied_by`).

The upgraded user is a regular signup: it keeps the explicitly granted roles
that migrated and gets nothing extra automatically (matching normal signup,
which grants no roles after the first admin).

> **Interaction with `ION_DISABLE_SIGNUP`:** the lockout closes
> `/api/auth/sign-up/*` once the first admin exists — which also blocks the
> guest *upgrade* path. Combine the two flags only if guests on your server
> never need to self-upgrade.

## Cleaning up never-upgraded guests

Enabling anonymous auth seeds a scheduled task, **`anonymous-user-cleanup`**
(type `anonymous_cleanup`), **disabled by default**. When enabled it runs daily
(03:00 by default) and deletes guests whose account is older than
`config.maxAgeDays` (default 30) — including their sessions and role
assignments. Upgraded users are never touched (they are no longer
`isAnonymous`). Enable and tune it from the admin console's Tasks page or
`PATCH /api/v1/tasks/:id`. Rate limiting already covers the sign-in endpoint
itself (`/api/auth/*` shares the stricter auth bucket).
