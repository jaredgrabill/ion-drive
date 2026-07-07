# Phase 12 — Events to the Edge (actor identity, webhooks, realtime, DLQ)

**Status: SHIPPED 2026-07-06** · Roadmap items F11, F15, F14, F18 (`docs/roadmap.md` Phase 12) · ADR-019.
All tiers landed as planned; deltas: the ambient-actor middleware had to use the
callback-hook + `AsyncLocalStorage.run` pattern (`enterWith` in an async hook
never reaches the handler — see ADR-019), SSE frames are unnamed so plain
`EventSource.onmessage` works, and disabling a webhook also unsubscribes its
consumer group (deliveries stop instantly; documented). Verified by 4 new
integration scenarios (suite now 15) + a 5-check boot-migration live smoke.

Phase 9 built the transactional outbox and dispatcher; Phase 12 takes those events to the
edges of the platform: every change knows **who** made it, external systems can receive
changes over **signed webhooks**, apps can subscribe to changes in **realtime** over SSE,
and failed deliveries finally have an **operational surface** (view + retry).

A tier is the unit of "done": each lands with unit tests and is independently shippable.
Tier 0 (the shutdown/port fix) shipped first as a standalone bugfix commit.

---

## Tier 0 — Shutdown fix (pre-phase bugfix) ✅

The admin console's SSE log tail kept `server.close()` from ever resolving (Fastify waits
for all connections), so the SIGINT handler never exited and the dead process kept the
port bound. Fixed: `forceCloseConnections: true`, a 10s shutdown watchdog, second-SIGINT
hard exit, and a Windows-aware tree reaper in `ion-drive dev`. This tier is also the
prerequisite for Tier 4 — every new long-lived SSE connection would otherwise make the
hang worse.

## Tier 1 — Actor identity (F11)

**Who:** `ActorRef = { userId, apiKeyId, via: 'session' | 'api_key' }`, derived from
`request.auth` (`AuthPrincipal`).

**How it threads — ambient, not parameters.** A new `runtime/request-context.ts` holds an
`AsyncLocalStorage<{ actor: ActorRef | null }>`. The session middleware calls
`enterWith()` after resolving `request.auth`, so the actor is ambient for the entire
request chain — REST handlers, GraphQL resolvers (yoga runs in-request), the per-request
MCP server, and the block installer all inherit it with **zero signature changes**.
Code running outside a request (dispatcher deliveries, scheduled tasks) correctly
resolves to no actor. `runWithActor(actor, fn)` is exported for programmatic embedders
and tests.

**Where it lands:**
- `created_by` / `updated_by` become **system fields** (SYSTEM_FIELDS), text, nullable,
  storing `userId ?? apiKeyId`. New tables get them at CREATE; existing objects get a
  boot migration (`ADD COLUMN IF NOT EXISTS` + missing `_ion_fields` rows) during
  `SchemaManager.initialize()`. `SYSTEM_MANAGED_COLUMNS` already lists them, so diffs
  stay clean. Being registry fields, they appear on REST/OpenAPI/GraphQL/MCP/admin grid
  for free; `sanitizeInput` keeps them read-only.
- `DataService.create/bulkCreate` set both; `update` sets `updated_by`.
- `CrudEventPayload` gains `actor: ActorRef | null`; `persist_event` gains a
  `payload.actorId` token (audit blocks map it onto `changed_by`).
- `_ion_migrations.applied_by` is populated from the ambient actor by the schema engine.

## Tier 2 — Delivery backoff + DLQ surface (F18)

- `_ion_event_deliveries` gains `next_attempt_at` (bootstrap `ADD COLUMN IF NOT EXISTS`).
  `markFailed` sets it with exponential backoff (base 5s, ×2 per attempt, cap 5 min);
  `findCandidates`/`claim` skip rows whose backoff hasn't elapsed. All handlers benefit.
- A delivery whose `attempts >= maxAttempts` is **dead** (DLQ) — no schema flag needed,
  it's a predicate.
- REST (`api/event-routes.ts`, RBAC resource `events`, self-guarding, gated by
  `ION_EVENTS_ENABLED`):
  - `GET /api/v1/events` — recent outbox events (topic filter, paging).
  - `GET /api/v1/events/deliveries?status=failed|pending|done&dead=true&consumer=` —
    ledger view joined to events (topic, attempts, error, timestamps).
  - `POST /api/v1/events/deliveries/retry` `{ eventId, consumer }` — resets the row's
    attempt budget so the dispatcher re-claims it immediately.

## Tier 3 — First-class outbound webhooks (F15)

**Design: webhooks ride the dispatcher.** Each webhook is a bus subscription with
consumer group `webhook:<id>` and the built-in `webhook` handler. That inherits, for
free: at-most-once per webhook across instances, the retry/backoff budget (Tier 2), the
delivery ledger as the **delivery log**, the DLQ view/retry, and `ion.event.*` metrics.

- `_ion_webhooks` (tenant DB): id, name, url, topics (jsonb patterns), enabled, secret
  (AES-256-GCM via the platform `Encryptor`), extra headers (jsonb), `managed_by`,
  timestamps. Secret is generated (`whsec_…`) and returned **once** on create, API-key
  style.
- `WebhookManager` (`messaging/webhooks.ts`): CRUD + (re)registers subscriptions on the
  bus at boot and on every mutation; `webhook` handler POSTs the event envelope with
  `x-ion-signature: t=<unix>,v1=hex(hmacSHA256(secret, "<t>.<body>"))` (Stripe-style,
  same scheme the invoicing block already verifies), `x-ion-event-id`, `x-ion-topic`,
  under the delivery abort signal; non-2xx → throw → ledger retry.
- REST `api/webhook-admin-routes.ts` at `/api/v1/webhooks` (RBAC resource `webhooks`):
  list/get/create/update/delete + `POST /:id/test` (publishes a `webhook.test` event
  scoped to that webhook's group).
- Block manifests gain optional `webhooks` (name/url/topics/headers); installer step
  `applyWebhooks` (idempotent by name, stamps `managed_by = block:<name>`), uninstall
  removes block-owned webhooks.

## Tier 4 — Realtime SSE subscriptions (F14)

**Design: an ephemeral cursor, not a consumer group.** A ledger-backed group would
replay the entire outbox for each new connection and write a delivery row per event per
connection. Instead `messaging/realtime.ts` (`RealtimeBridge`) polls `_ion_events` by a
`(occurred_at, id)` cursor that starts at connect time — no ledger writes, best-effort
delivery (documented), a small seen-id LRU + a 5s overlap window to absorb commit-order
skew. The bridge only polls while clients are connected, and `OutboxBus.wake` fans out
to both the dispatcher and the bridge, so delivery is near-instant after commit.

- `GET /api/v1/events/stream?topics=data.contacts.*,data.orders.created` — SSE
  (`event: <topic>`, `data: <IonEvent JSON>`, heartbeats, same shape as the log tail).
  Topic patterns use the existing `topic-match` grammar; default `data.#`.
- **RBAC-filtered per event**: `data.<object>.<op>` requires `read` on `<object>`
  (checked via `PermissionEngine.can`, cached per connection); other topics require
  `read` on `events`. Unauthorized events are silently skipped, not errors.
- Client SDK: `client.events.stream(topics, onEvent)` — a zero-dependency fetch-streaming
  SSE consumer with auto-reconnect (Last-Event-ID = event id).
- GraphQL subscriptions: deferred (Phase 13 does GraphQL relationship work; revisit
  there if yoga's SSE transport makes it cheap).

## Tier 5 — Admin, docs, verification

- **Admin**: new **Events** page (deliveries table w/ status filter + dead toggle +
  retry button; live event feed tab over the new SSE stream) and **Webhooks** page
  (CRUD sheet, enable toggle, secret-shown-once dialog, per-webhook delivery log filter),
  both under OBSERVE in the sidebar; lazy chunks to protect the bundle budget.
- **Docs**: `docs/concepts/events.md` grows actor/webhooks/realtime/DLQ sections;
  `docs/api/realtime.md` (stream contract + SDK usage); rest.md notes `created_by`/
  `updated_by`.
- **Tests**: unit (request-context, backoff/claim SQL shape, webhook signing/handler,
  realtime bridge match+RBAC filter, event-routes, webhook routes) + integration
  scenarios (actor lands in columns/events; webhook delivered to a local receiver with
  valid signature; SSE stream receives a create; retry endpoint revives a dead delivery).
- **Live smoke** (`live-smoke` skill): N-check against dev Postgres incl. admin pages.
- Close-out: ADR-019, roadmap pruning, CLAUDE.md/implementation_plan status, memory.

## Out of scope (unchanged from roadmap)

GraphQL relationship traversal + subscriptions (Phase 13), file storage (15),
multi-tenancy (16), field/row-level RBAC (17 — but `created_by` is its prerequisite,
which is why actor identity leads this phase).
