# Events & the Message Bus

Ion Drive has a built-in **message bus** so different parts of the system —
core, building blocks, and plugins — can react to each other's changes without
being wired together directly. Every record create, update, and delete emits an
event; anything can subscribe. This is the substrate that lets blocks and
plugins cooperate with **loose coupling**.

The default bus is **durable and needs no broker**: it's a Postgres
*transactional outbox*. A Redis Streams bus can replace it via a plugin without
changing any of your code. See [ADR-015](../research/architecture-decisions.md).

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
| `data.<object>.created` | a record is created | `{ object, id, op, before: null, after, diff: null }` |
| `data.<object>.updated` | a record is updated | `{ object, id, op, before, after, diff }` |
| `data.<object>.deleted` | a record is deleted | `{ object, id, op, before, after: null, diff: null }` |

The `diff` on updates is a `{ field: { before, after } }` map of the business
fields that changed. **System-managed columns (`created_at`, `updated_at`, and
future `*_by`) are never included in the diff.**

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
`payload.before`, `payload.after`, `payload.diff`, and `payload.record`
(after-image, falling back to the before-image on deletes).

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
