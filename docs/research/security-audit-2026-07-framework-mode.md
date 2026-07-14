# Security Audit — Framework Mode & Hardening Knobs (2026-07)

**Scope:** Adversarial review of the Phase 14 hardening commit (`88e8296`, on `main`) and
the end-user attack surface of a project produced by `ion-drive init` running in framework
mode. This is an audit/backlog document — prune findings as they ship (link the fixing
commit/PR next to each).

**Reviewer stance:** success messages ("23 tests / 12-check smoke / closes the checklist gaps")
were not taken at face value. The hardening *knobs* are implemented correctly in isolation, but
they are **opt-in and every one of them is off in the default scaffolded `.env`**, which inverts
the security posture the checklist claims to close. The two dominant findings (V1, V2) are
defaults, not code bugs.

## Validation performed
- `pnpm lint` → exit 0; `pnpm typecheck` → exit 0.
- Targeted `vitest` (`config.test.ts`, `admin-static.test.ts`, `encryption.test.ts`) → 28 passed.
  Note: the config tests exercise **env parsing only**, not runtime enforcement or concurrency.
- Grep for `.skip/.only/.todo/xit` across `**/*.ts` → none. Recent test commits (`f0b948e`
  warm-up, `fdaca00` de-Stripe fixtures) preserve their assertions — not disabled/gamed.
- Code read: `config/index.ts`, `server.ts` (CORS / metrics / signup guard / enforcement
  wiring), `api/admin-static.ts`, `auth/better-auth-adapter.ts`, `auth/rbac/role-manager.ts`,
  `api/hook-routes.ts`, `api/admin-routes.ts`, `cli/src/project-scaffold.ts`.

---

## Remediation status (2026-07-12)

All seven findings are **fixed**, each as its own commit on branch
`security/framework-mode-audit-fixes` with a regression test:

| Finding | Severity | Fixing commit | Summary of fix |
| --- | --- | --- | --- |
| V1 | Critical | `0270267` | Refuse open-mode boot in production (unless `ION_ALLOW_OPEN=true`); scaffold `ION_REQUIRE_AUTH=true`. |
| V2 | Critical | `b813fc2` | Refuse wildcard credentialed CORS at boot; default same-origin; explicit allowlist otherwise. |
| V3 | High | `2a0222d` | Serialize the first-admin bootstrap with a transaction-scoped advisory lock. |
| V5 | High | `36000b7` | Move signup lockout into Better Auth's own router (a `before` hook); fuzzing found no live bypass in 1.6.23. |
| V4 | Medium | `9490175` | Gate the signup lockout on a durable `_ion_config` marker, not a live assignment count. |
| V6 | Medium | `8dc4756` | Boot-time warnings for open `/metrics` and non-production posture (loopback-only metrics rejected — see below). |
| V7 | Medium | `8dc4756` | One-shot runtime warning when `X-Forwarded-For` arrives while `trustProxy` is off. |

**Deferred sub-item:** V6's "loopback-only metrics when no token" was considered and **not**
implemented — restricting `/metrics` to loopback source IPs would break the shipped docker
observability overlay's cross-host scrape (`host.docker.internal`); the bearer token plus the
boot-time warning are the recommended controls instead.

## Findings

Severity: **Critical** = exploitable in the default deployment; **High** = exploitable under a
plausible (documented) configuration; **Medium** = availability/operational footgun or
defense-in-depth gap.

### V1 — Default project runs with authentication disabled on every endpoint  ·  Critical
- Scaffolded `.env` (`cli/src/project-scaffold.ts:106-117`) sets only `ION_PORT`,
  `ION_DATABASE_URL`, `ION_ENCRYPTION_KEY`, `ION_AUTH_SECRET`. `ION_REQUIRE_AUTH` is unset →
  `false` (`config/index.ts:71`).
- `server.ts:488` logs `'RBAC enforcement disabled (ION_REQUIRE_AUTH not set) — all endpoints open'`.
- Routes documented as "self-guarding" are **not**: they all receive `enforce: config.requireAuth`
  (`server.ts:215,228,591,617,630,643,654`), and `admin-routes.ts:50` makes the guard a total
  no-op when `enforce` is false: `if (!services.enforce) return (_req,_reply,done) => done();`
  (no session, no permission — anonymous allowed).
- **Impact (anonymous, default deploy):** `POST /api/v1/api-keys` mints a persistent API key;
  `/api/v1/users` + `/api/v1/roles` self-assign admin; `/api/v1/secrets` + `/api/v1/config`
  overwrite/delete secrets; `DELETE /api/v1/schema/objects/:name` drops tables; `/api/v1/blocks`
  install can register an `http_request` task (SSRF).
- **Fix direction:** scaffold `ION_REQUIRE_AUTH=true` by default, and/or have `createServer`
  refuse to boot with RBAC off unless `NODE_ENV=development` (or an explicit
  `ION_ALLOW_OPEN=true` acknowledgement), logging at `error` not `warn`.
- **Fixed** (`0270267`): `assertSafeAuthPosture` refuses the production open boot; scaffold + docs
  set `ION_REQUIRE_AUTH=true`. Regression: `security-defaults.integration.test.ts` (exploit + guard).

### V2 — Wide-open credentialed CORS by default (`origin: true` + `credentials: true`)  ·  Critical
- `corsOrigins` defaults to `true` (`config/index.ts:42`); `server.ts:320-323` registers
  `@fastify/cors` with `origin: config.corsOrigins, credentials: true`. Scaffold never sets
  `ION_CORS_ORIGINS`.
- `@fastify/cors` with `origin:true` reflects the caller's `Origin` and, with `credentials:true`,
  emits `Access-Control-Allow-Credentials: true` — the exact combination the spec/docs warn against.
- **Impact:** with cookie auth + the same-origin `/admin` console, any site an admin visits can
  make credentialed `fetch(...,{credentials:'include'})` calls, read responses, and drive
  mutations (schema, API-key creation, data) — cross-site data-exfil / CSRF.
- **Fix direction:** refuse (hard error) `origin:true` together with `credentials:true`; default
  to same-origin; require an explicit allowlist when credentials are enabled.
- **Fixed** (`b813fc2`): `resolveCorsOptions` throws on a wildcard origin; default `false`
  (same-origin). Regression: `cors-options.test.ts` + `security-defaults.integration.test.ts`.

### V3 — TOCTOU race: `ION_DISABLE_SIGNUP` + bootstrap can mint multiple admins  ·  High
- The signup guard (`server.ts` `buildSignupGuard` → `assignmentCount() > 0`) and the bootstrap
  grant (`server.ts:329-338` `onUserCreated` → `assignmentCount() === 0`) both read the same
  unsynchronized `SELECT count(*)` (`role-manager.ts:117-123`). `onUserCreated` fires in Better
  Auth's `user.create.after` hook (`better-auth-adapter.ts:59`), separate from the guard check.
- **Failure scenario:** two concurrent sign-ups in the first-boot window (before the first
  admin's `_ion_user_roles` insert commits) both observe `count == 0` → both pass the guard and
  both are granted admin. Violates "only the first user is admin, then signup locks."
- **Fix direction:** single transaction with `SELECT … FOR UPDATE` / a PG advisory lock around
  the check-create-grant, or a unique partial index enforcing exactly one bootstrap admin.
- **Fixed** (`2a0222d`): `RoleManager.grantAdminIfFirstUser` runs the check-and-grant under a
  transaction-scoped `pg_advisory_xact_lock`. Regression: 25 concurrent grants → one admin.

### V4 — Signup lockout silently re-opens if role assignments reach zero  ·  Medium
- The guard keys on `assignmentCount() > 0`, not "signup ever completed" (documented as
  intentional). If the last role assignment is ever removed (migration to API-key-only access, or
  an attacker with `manage` on `roles`), public signup re-opens and the next signup becomes admin.
- **Fix direction:** gate on a durable "bootstrap complete" flag (e.g. a `_ion_config` marker) set
  once, instead of a live count; keep the count only for the first-ever boot.
- **Fixed** (`9490175`): durable `_ion_config` marker `bootstrap.completed` set atomically with the
  first grant + backfilled at boot; the guard reads it, not the count. Regression:
  `signup-lockout.integration.test.ts` (still 403 after all assignments removed).

### V5 — Signup match uses a second router; divergence = lockout bypass  ·  High (unverified)
- The guard matches `request.url.startsWith('/api/auth/sign-up')` on Fastify's parsed URL, then
  Better Auth routes `request.raw.url` with its own (better-call) router. Any case/encoding/
  normalization difference that Better Auth still routes to signup but the prefix check misses
  (e.g. `/api/auth/Sign-Up/email`, percent-encoding) bypasses the 403 while still creating the
  account. **Plausible, not yet PoC'd** — needs fuzzing against Better Auth's routing.
- **Fix direction:** enforce the block inside the same router that dispatches signup (a Better
  Auth hook / `before` handler), not a prefix check in the outer scope.
- **Fixed** (`36000b7`): enforcement moved to a Better Auth `before` hook keyed on `ctx.path`; the
  outer prefix check removed. Fuzzing (mixed-case, percent-encoded, double-slash, dot-segment)
  found **no** live bypass in better-auth 1.6.23 — better-call is case-sensitive and does not
  percent-decode before matching — but the two-router hazard is eliminated regardless. Regression:
  `signup-lockout.integration.test.ts`.

### V6 — `/metrics` open by default; helmet CSP only in production  ·  Medium
- `ION_METRICS_TOKEN` unset by default (`config/index.ts:132`) → `/metrics` served to anyone
  (`server.ts` `installMetricsEndpoint`), leaking object names, traffic/error volumes, structure.
  Compounds V1.
- `helmet` sets CSP only when `nodeEnv === 'production'` (`server.ts:326`); the scaffold never
  sets `NODE_ENV`, so a naive `npm start` deploy runs in development mode (no CSP over the
  same-origin admin SPA, verbose logging).
- **Fix direction:** document/require `NODE_ENV=production` for deploys; consider defaulting the
  metrics endpoint to loopback-only when no token is set.
- **Fixed** (`8dc4756`): boot-time warnings for open `/metrics` and non-production posture
  (`collectBootAdvisories`); docs updated. Loopback-only metrics **deferred** — it would break the
  shipped docker observability overlay's cross-host scrape; token + warning are the controls.
  Regression: `security-advisories.test.ts`.

### V7 — `trustProxy=false` default is an availability footgun behind a proxy  ·  Medium
- Default `false` is correct against IP spoofing, but the rate limiter keys on `request.ip`
  (`installRateLimit`). Behind the normal reverse-proxy deploy with the default, every client
  collapses to the proxy IP → the auth bucket (20/min) and global bucket (300/min) are shared
  across the whole internet: one actor locks out all users. Both `true` and `false` have a failure
  mode and the default one is silent.
- **Fix direction:** detect "behind a proxy but `trustProxy=false`" at boot (e.g. warn when
  `X-Forwarded-For` is present but not trusted) and document the correct setting prominently.
- **Fixed** (`8dc4756`): one-shot `onRequest` warning when `X-Forwarded-For` arrives while
  `trustProxy` is off (`isUntrustedForwardedFor`); checklist §6 documents the correct setting.
  Regression: `security-advisories.test.ts`.

---

## What checks out (no action)
- `bearerTokenMatches` (`server.ts`) is a correct constant-time comparison — SHA-256 both sides to
  fixed 32-byte buffers before `timingSafeEqual` (no length leak, no throw). Cosmetic: `'Bearer '`
  prefix is case-sensitive; RFC 7235 scheme is case-insensitive.
- `admin-static.ts` delegates traversal defense to `@fastify/static`; asset-404 vs SPA-fallback
  split is sound. No traversal issue found.
- `envBoolean` correctly handles falsy spellings (avoids the `z.coerce.boolean` all-truthy trap).
  *Post-audit correction (2026-07-13, launch-plan Lane 0):* `requireAuth` itself was still parsed
  with `z.coerce.boolean()`, so `ION_REQUIRE_AUTH=false` silently enforced auth (safe direction,
  but the documented off switch was a no-op and the V1 production refusal was unobservable when
  the var was set to a falsy spelling). Switched to `envBoolean(false)`.
- The two recent test commits are legitimate, not disabled tests.

---

## Remediation goal prompt

Paste into `/goal` (or hand to a fresh session) to drive the fixes. Ordered by severity; each
item is independently shippable as its own commit/PR.

```
You are fixing the security findings in docs/research/security-audit-2026-07-framework-mode.md.
Work findings top-down (V1 → V7). For each: reproduce first with a FAILING test, then fix, then
show the test passing. Do not weaken or delete existing tests. Every change is its own commit on a
branch and lands via a merged PR — nothing left uncommitted. Keep REST/GraphQL/MCP/OpenAPI/admin
in lockstep (surface-parity skill) and run `pnpm lint && pnpm typecheck && pnpm test` before each commit.

Priority order and acceptance criteria:
1. V1 (auth-off default): add a failing integration test proving an ANONYMOUS caller can
   `POST /api/v1/api-keys` and self-assign admin on a default-config server. Then make the default
   safe — scaffold `ION_REQUIRE_AUTH=true`, and/or refuse to boot with RBAC off unless
   NODE_ENV=development or an explicit ION_ALLOW_OPEN=true is set (log at error). Update
   project-scaffold.ts, .env.example, the security checklist, and getting-started.
2. V2 (credentialed CORS): failing test proving a cross-origin credentialed request is reflected
   and allowed. Then hard-error on `origin:true` + `credentials:true`; default same-origin; require
   an explicit allowlist when credentials are on. Update config docs.
3. V3 (double-admin race): failing concurrent-signup test (two simultaneous sign-ups during
   bootstrap both become admin). Fix with a transaction + row lock or a unique bootstrap-admin index.
4. V5 (signup match bypass): fuzz mixed-case/percent-encoded signup paths against Better Auth's
   router; if a bypass exists, move enforcement into the same router (a Better Auth before-hook).
5. V4 (lockout re-open): gate signup on a durable "bootstrap complete" marker, not a live count.
6. V6 (metrics/CSP defaults) and V7 (trustProxy footgun): boot-time warnings + docs; consider
   loopback-only metrics when no token is set.

Definition of done: every finding either fixed (with a regression test) or explicitly deferred with
a one-line rationale appended to the audit doc; audit doc updated with fixing commit hashes; all work
committed and PR(s) merged.
```
