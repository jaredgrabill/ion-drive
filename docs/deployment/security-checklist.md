# Security Checklist

A practical hardening pass for a production Ion Drive deployment. Every item
below maps to something that actually exists in the code — work through it
top to bottom before exposing a server to the internet.

## 1. Turn authentication on

`ION_REQUIRE_AUTH` defaults to **`false`** — out of the box, every data,
schema, and admin endpoint is open. That is a deliberate local-development
default and must be flipped in production:

```bash
ION_REQUIRE_AUTH=true
```

With it on, RBAC is enforced across REST, GraphQL, MCP, schema, and admin
routes. A few endpoints stay public by design: `/health`, `/api/v1` (the
endpoint index), `/api/v1/openapi.json`, and `/api/auth/*`. Note that the
OpenAPI spec reveals your schema's shape — if that matters to you, keep the
server off the public internet or behind your own gateway.

## 2. Set strong secrets

Generate real values for both keys:

```bash
# 32-byte hex — used for AES-256-GCM secret encryption
openssl rand -hex 32          # → ION_ENCRYPTION_KEY
# or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

openssl rand -hex 32          # → ION_AUTH_SECRET (signs sessions/tokens)
```

With `NODE_ENV=production` the server **refuses to boot** unless at least one
of them is set; in development it falls back to a fixed, publicly-known dev
key (and warns). Use two distinct values, store them in a secret manager, and
back up `ION_ENCRYPTION_KEY` with your database — without it, stored secrets
are unrecoverable (see [Backup & Restore](backup-restore.md)).

## 3. Run with `NODE_ENV=production`

Beyond the boot guard above, production mode:

- enables helmet's **Content-Security-Policy** (the other helmet headers are
  always on), and
- **disables GraphiQL** — the playground at `/api/v1/graphql` is served
  whenever `NODE_ENV` is not `production`, regardless of auth settings. (Even
  with RBAC on, the playground *page* loads over GET by design; the actual
  GraphQL operations are POSTs and are guarded.)

## 4. Terminate TLS in front of the server

The container speaks plain HTTP. Put a reverse proxy or ingress
(nginx/Caddy/Traefik/cloud LB) in front for TLS, and set `ION_PUBLIC_URL` to
the public HTTPS URL so the auth provider issues correct base URLs.

## 5. Lock down CORS

The default `ION_CORS_ORIGINS` is allow-all (`true`) **with credentials
enabled** — any website could make authenticated requests on behalf of a
logged-in user's browser. Pin it to your frontend's origin:

```bash
ION_CORS_ORIGINS=https://app.example.com
```

(The env var takes a single origin string; multiple origins require
programmatic configuration via `createServer`.)

## 6. Tune rate limiting

Per-IP rate limiting is **on by default** (`ION_RATE_LIMIT_ENABLED=true`):
a global bucket of 300 requests/minute plus a stricter 20 requests/minute
bucket for `/api/auth/*` (login brute-force protection). Adjust for your
traffic:

```bash
ION_RATE_LIMIT_MAX=300          # global bucket per IP per window
ION_RATE_LIMIT_AUTH_MAX=20      # /api/auth/* bucket per IP per window
ION_RATE_LIMIT_WINDOW_MS=60000
```

Two caveats: `/health` and `/metrics` are exempt (probes and scrapers), and
the limiter keys on `request.ip`. Fastify's `trustProxy` is **not** enabled,
so behind a reverse proxy every client shares the proxy's IP — and therefore
one bucket. Until a `trustProxy` config knob exists, do the rate limiting at
the proxy itself in proxied deployments.

## 7. Firewall `/metrics`

When `ION_METRICS_ENABLED=true` (the default), `GET /metrics` serves
Prometheus text with **no authentication** and no rate limiting. It leaks
operational detail (routes, error rates, task names). Keep it network-internal
— cluster-only, a firewall rule, or a proxy block — or disable it with
`ION_METRICS_ENABLED=false` if you don't scrape it.

## 8. Practice API-key hygiene

API keys (`iond_…`) are hashed with SHA-256 at rest — the plaintext is shown
**once** at creation and never stored, so a leaked database doesn't leak
usable keys. There are no per-key scopes; a key's permissions come entirely
from the user and/or role it is bound to. So:

- bind every key to the **least-privileged role** that works (e.g. `viewer`
  for read-only integrations) — never leave an admin-bound key lying around;
- set an expiry (`expiresAt`) on keys for short-lived integrations;
- rotate by creating a new key and revoking the old one via the admin
  console's **API Keys** page or `DELETE /api/v1/api-keys/:id`.

## 9. Review roles and the first-admin bootstrap

Three roles are seeded: **admin** (everything), **editor**, and **viewer**.
Two things to internalize:

- **The first user to sign up becomes admin.** Sign up yourself immediately
  after first boot, before the server is reachable by anyone else.
- **Signup stays open** after that. Later signups receive no roles — with
  `ION_REQUIRE_AUTH=true` they can authenticate but do nothing — but they can
  still create accounts. The stricter auth rate-limit bucket blunts abuse;
  if open registration is unacceptable for your deployment, keep `/api/auth/*`
  behind your network perimeter.

Audit role permissions (`/api/v1/roles` or the admin console) after installing
building blocks — blocks may seed roles of their own.

## 10. Isolate PostgreSQL

Everything — data, users, secrets, API-key hashes — is in one database.

- Never expose Postgres to the public internet; private network/VPC only.
- Use a strong, unique password (not the dev `ion:ion`) and a dedicated user.
- Add `?sslmode=require` to `ION_DATABASE_URL` when the path to the database
  isn't a private network.

## 11. Disable what you don't use

Every optional subsystem has a flag (all default **on**):

```bash
ION_TASKS_ENABLED=false     # scheduled-task engine
ION_BLOCKS_ENABLED=false    # /api/v1/blocks install surface
ION_EVENTS_ENABLED=false    # message bus + CRUD change events
ION_METRICS_ENABLED=false   # /metrics endpoint
```

Smaller surface, fewer surprises. (REST/GraphQL/MCP are the core product and
have no off switch; they are covered by RBAC.)

## 12. Report vulnerabilities responsibly

Found something? **Don't open a public issue.** Email
**jared@ionshiftlabs.com** per [SECURITY.md](../../SECURITY.md) — acknowledgement
within 3 business days, assessment within 14.
