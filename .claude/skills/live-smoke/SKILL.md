---
name: live-smoke
description: Recipe for end-to-end verification of a feature against a real server + Postgres — the numbered N-check live smoke every phase ends with.
---

# Live smoke recipe

Every phase closes with a live smoke: boot the real server against dev Postgres, bootstrap
auth, run numbered checks, tear down. This is the repeatable version.

## 1. Postgres

```bash
docker compose -f docker/docker-compose.yml up -d
```

The repo compose maps host port **5432** (`postgresql://ion:ion@localhost:5432/ion_drive`),
but the port may be remapped locally (this dev machine runs it on **5433**). **Honor
`ION_DATABASE_URL` if the environment or a `.env` file sets it** — never assume 5432; check
`docker ps` / the env before hardcoding a connection string.

## 2. Build and start the server

```bash
pnpm --filter @ionshift/ion-drive-core build
node packages/core/dist/server.js     # or: pnpm --filter @ionshift/ion-drive-core dev
```

Run it in the background, capture its log to the scratch dir, and poll `GET /health` until
it returns 200 before running any checks.

### Env gotchas (defaults from `packages/core/src/config/index.ts`)

- `ION_REQUIRE_AUTH` defaults **false** — RBAC guards are no-ops. Set it to `true` if the
  smoke is supposed to exercise permissions; otherwise unauthenticated requests succeed and
  prove nothing about auth.
- **Rate limiting is ON by default** (`ION_RATE_LIMIT_ENABLED=true`; 300 req/min global,
  **20 req/min on `/api/auth/*`**). Smokes hammer endpoints in bursts — set
  `ION_RATE_LIMIT_ENABLED=false` or raise `ION_RATE_LIMIT_MAX`, or you'll debug phantom 429s.
- `ION_TASKS_ENABLED`, `ION_BLOCKS_ENABLED`, `ION_EVENTS_ENABLED` all default **on** — the
  event dispatcher and scheduler run unless you switch them off.

## 3. Bootstrap auth

1. Sign up the **first** user — it auto-becomes admin:
   `POST /api/auth/sign-up/email` with `{ "email", "password", "name" }` (Better Auth,
   mounted at `/api/auth`). Capture the session cookie from the response.
2. Mint an API key with that cookie: `POST /api/v1/api-keys` with `{ "name": "smoke" }`.
   The plaintext key (`iond_…`) is returned **exactly once** in `data.key`.
3. Use `X-API-Key: iond_…` (or `Authorization: Bearer iond_…`) on all subsequent checks —
   API keys resolve first in `packages/core/src/auth/session-middleware.ts`.

Note: signup requires a **fresh database** to yield an admin. If the DB already has users,
either reuse existing credentials or `docker compose down -v` first.

## 4. Structure the checks

- Write **one script** (Node or PowerShell) in the session **scratch directory** — never
  committed, never in the repo tree.
- Number every check (`[1/N] …`) and keep a pass/fail counter; print a final summary line.
- Assert **status codes AND payload shapes** — e.g. `201` *and* `body.data.id` exists,
  `body.data` is an array of length 3, error body has the expected `error`/`code`. A 200
  with a wrong envelope is a failure.
- **Clean up at the end**: delete created records, `DELETE /api/v1/schema/objects/:name`
  for created objects, `DELETE /api/v1/blocks/:name?dropData=true` for installed blocks.
  Cleanup failures are check failures too.

## 5. Afterward: codify the keepers

Ad-hoc smokes get discarded; the durable version is an integration test. The seed suite
already exists: `packages/core/src/integration/platform.integration.test.ts` (added
2026-07-06) boots the real server via `createServer()` — no port binding, Fastify
`.inject()` — against a **per-run scratch database** (`CREATE DATABASE ion_it_<random>`
on the server from `ION_DATABASE_URL`, dropped in `afterAll`) and covers auth bootstrap,
schema + CRUD + constraints, `expand=`, GraphQL, outbox events, block lifecycle, and RBAC.
**Extend that suite** (or add a sibling `*.integration.test.ts`) with new checks worth
keeping rather than starting from scratch; it is picked up by
`vitest.integration.config.ts` (excluded from the unit run) and executed with:

```bash
pnpm --filter @ionshift/ion-drive-core test:integration
```

Two footguns the seed suite already solves — copy its patterns: `createServer()` returns
a `close()` for full teardown (dispatcher, pools, telemetry) without `process.exit`, and
the integration vitest config aliases `graphql` to its CJS entry (vite-node otherwise
splits graphql into two module realms and every GraphQL request 500s).

Report the smoke as "N/N checks passed" with the feature areas covered, and note which
checks you codified (or deliberately didn't) as integration tests.
