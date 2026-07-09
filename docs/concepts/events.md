# Events & the Message Bus

Ion Drive has a built-in **message bus** so different parts of the system —
core, building blocks, and plugins — can react to each other's changes without
being wired together directly. Every record create, update, and delete emits an
event; anything can subscribe. This is the substrate that lets blocks and
plugins cooperate with **loose coupling**.

The default bus is **durable and needs no broker**: it's a Postgres
*transactional outbox*. A Redis Streams bus can replace it via a plugin without
changing any of your code. See [ADR-015](https://github.com/jaredgrabill/ion-drive/blob/main/docs/research/architecture-decisions.md).

## The mental model

```
 write + event row  ──▶  ONE database transaction   (no dual-write gap)
                              │
                        _ion_events (outbox)
                              │
                    EventDispatcher drains it
                              │
             ┌────────────────┼─────────────────┐
             ▼                ▼                  ▼
        consumer "audit"  consumer "email"  consumer "cache"
        (once per group, even across app instances)
```

- **Publishing** an event writes a row into `_ion_events` **in the same
  transaction** as the data write, so an event is never emitted for a change
  that rolled back — and never lost after one that committed.
- **Delivering** is done asynchronously by the dispatcher, so writes never block
  on consumers.
- Each **named consumer group** processes every matching event **at most once**,
  even when several app instances share one database (the `_ion_event_deliveries`
  table + `SELECT … FOR UPDATE SKIP LOCKED` are the arbiter). Different consumer
  groups each get their own copy — that's the fan-out.

## CRUD events

Every data mutation through the [Data API](../api/rest.md) emits:

| Topic | When | Payload |
|---|---|---|
| `data.<object>.created` | a record is created | `{ object, id, op, before: null, after, diff: null, actor }` |
| `data.<object>.updated` | a record is updated | `{ object, id, op, before, after, diff, actor }` |
| `data.<object>.deleted` | a record is deleted | `{ object, id, op, before, after: null, diff: null, actor }` |

The `diff` on updates is a `{ field: { before, after } }` map of the business
fields that changed. **System-managed columns (`created_at`, `updated_at`,
`created_by`, `updated_by`) are never included in the diff.**

Many-to-many **link writes** (Phase 13) emit their own pair:

| Topic | When | Payload |
|---|---|---|
| `data.<object>.linked` | junction rows added via the links API | `{ object, id, op, relationship, targetObject, targetIds, actor }` |
| `data.<object>.unlinked` | junction rows removed | same shape |

`targetIds` carries only the ids that actually changed — idempotent replays
(re-linking an existing pair) emit nothing.

### Actor identity (Phase 12)

Every payload carries `actor: { userId, apiKeyId, via: 'session' | 'api_key' } | null`
— who made the change, resolved from the request's session or API key
(`null` for anonymous or system writes). The same identity is stamped onto
the record itself: every object has nullable `created_by`/`updated_by`
system columns storing the opaque actor id (`userId`, else `apiKeyId`).
These columns are read-only through the API — client-supplied values are
stripped and re-stamped server-side. Schema changes record the actor too, in
`_ion_migrations.applied_by`.

Programmatic embedders running outside an HTTP request can scope an actor
explicitly:

```ts
import { runWithActor } from '@ion-drive/core';

await runWithActor({ userId: 'system-import', apiKeyId: null, via: 'session' }, () =>
  dataService.create('contacts', { full_name: 'Imported Ida' }),
);
```

## Topic patterns

Subscriptions match topics with the AMQP-style convention:

| Pattern | Matches |
|---|---|
| `data.contacts.created` | exactly that topic |
| `data.*.created` | a create on any object (`*` = one segment) |
| `data.contacts.#` | any change to `contacts` (`#` = zero or more segments) |
| `data.#` | every data event |

## Delivery guarantees

- **At-least-once** delivery with **idempotency on `event.id`** — a handler may
  occasionally see an event twice (e.g. a crash between processing and
  acknowledging), so handlers should be safe to re-run.
- **At-most-once per consumer group** across the cluster (the default), so a
  side effect like sending an email or writing an audit row happens once even
  with multiple app instances.
- Set `perInstance: true` on a subscription to instead deliver **once per
  instance** — useful for in-memory concerns like cache invalidation.
- **Failed deliveries back off exponentially** (5s × 2 per attempt, capped at
  5 minutes) up to a budget of 5 attempts. A delivery that exhausts the budget
  is a **dead letter** — visible (and retryable) at
  `GET /api/v1/events/deliveries?dead=true` and on the admin **Events** page.
  The retry action (`POST /api/v1/events/deliveries/retry` with
  `{ eventId, consumer }`) resets the attempt budget and redelivers
  immediately.

## Subscribing

### From a building block (declarative)

A block declares subscriptions in its manifest; the handler is referenced by
name (a built-in like `persist_event`, or one a plugin registered):

```json
{
  "subscriptions": [
    {
      "event": "data.#",
      "consumer": "audit",
      "handler": "persist_event",
      "config": {
        "object": "audit_log",
        "map": {
          "object_name": "payload.object",
          "record_id": "payload.id",
          "operation": "payload.op",
          "diff": "payload.diff",
          "snapshot": "payload.record",
          "event_id": "event.id"
        }
      }
    }
  ]
}
```

This is exactly what the bundled **`audit`** block does — one row per change in
an `audit_log` table. Because `audit` is a single consumer group, you get one
audit record per change, even across instances.

### From a plugin (code)

```ts
export default definePlugin({
  name: 'welcome-mailer',
  setup(ctx) {
    ctx.bus.on('data.users.created', 'welcome-mailer', async (event) => {
      const user = (event.payload as { after: { email: string } }).after;
      await ctx.registry.require(EMAIL_SERVICE).send({
        to: user.email,
        subject: 'Welcome!',
        text: 'Thanks for signing up.',
      });
    });
  },
});
```

## Built-in handlers

| Handler | Purpose |
|---|---|
| `log_event` | Logs the matched event (handy while developing a subscription). |
| `persist_event` | Writes the event into a configured data object using a column→token map. Writes through an event-suppressing path, so it never recurses. |

Token vocabulary for `persist_event`'s `map`: `event.id`, `event.topic`,
`event.occurredAt`, `payload.object`, `payload.id`, `payload.op`,
`payload.before`, `payload.after`, `payload.diff`, `payload.record`
(after-image, falling back to the before-image on deletes), `payload.actor`
(the structured actor), and `payload.actorId` (the same opaque id
`created_by`/`updated_by` store — what an audit block maps onto
`changed_by`).

## Outbound webhooks (Phase 12)

A **webhook** pushes matching events to an external URL — stored config
(`/api/v1/webhooks`, or the admin **Webhooks** page) rather than code. Under
the hood each webhook is just a subscription with consumer group
`webhook:<id>` and the built-in `webhook` handler, so it inherits everything
above: once-per-webhook across instances, retries with backoff, the delivery
ledger as its delivery log, and the DLQ view/retry.

- **Signing:** every request carries
  `x-ion-signature: t=<unix seconds>,v1=<hex hmac>` where the HMAC-SHA256 is
  computed over `"<t>.<raw body>"` with the webhook's `whsec_…` secret — the
  secret is generated at creation and shown **exactly once**. Verify with a
  constant-time compare and reject stale timestamps (the invoicing block's
  `verifyStripeSignature` shows the receiving side of the same scheme).
- The body is the event envelope: `{ id, topic, payload, occurredAt }`.
  `x-ion-event-id` and `x-ion-topic` headers carry the essentials for cheap
  routing; use `id` as your idempotency key.
- A non-2xx response (or timeout) marks the delivery failed and schedules a
  backed-off retry. Disabling a webhook stops deliveries immediately.
- `POST /api/v1/webhooks/:id/test` fires a `webhook.test.<id>` event through
  the full pipeline.
- Block manifests may declare `webhooks` (name/url/topics/headers); the
  installer provisions them stamped `block:<name>` (their one-time secrets
  appear in the install report) and uninstall removes them.

## Realtime subscriptions (Phase 12)

`GET /api/v1/events/stream?topics=data.contacts.*,data.orders.created` bridges
the bus to **Server-Sent Events** — see [Realtime API](../api/realtime.md)
for the wire contract and the client SDK's `ion.events.stream(...)`. Delivery
is best-effort from connect time (no replay, nothing persisted) and is
RBAC-filtered per event: `data.<object>.*` requires `read` on the object.
Consumers that need guarantees use a subscription (consumer group) instead —
realtime is a feed, not a queue.

## Observability

Every delivery runs inside an OpenTelemetry span (`event <topic>`), and the bus
records custom metrics alongside the platform's `ion.task.*` instruments:
`ion.event.published` counts events written to the outbox (by `ion.event.topic`),
while `ion.event.deliveries` and the `ion.event.delivery.duration` histogram (ms)
track each delivery attempt, dimensioned by topic, consumer group, handler, and
outcome (`success` | `failed`). All of it is exposed at `GET /metrics` (or over
OTLP) when telemetry is enabled, and is a no-op otherwise.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `ION_EVENTS_ENABLED` | `true` | Master switch. When off, the bus is a no-op and no events are emitted (zero write overhead). |
| `ION_EVENTS_POLL_INTERVAL_MS` | `2000` | Dispatcher fallback poll cadence. A commit also nudges the dispatcher, so this mainly bounds pickup of events published by *other* instances. |

## Replacing the bus

The default bus is in-process/single-database. A plugin can register a
distributed transport (e.g. Redis Streams) under the `MESSAGE_BUS` token; the
outbox + consumer-group model maps directly onto it. See
[Plugins](./plugins.md).
