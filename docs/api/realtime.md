# Realtime API (Server-Sent Events)

Subscribe to change events as they happen — the outbox's committed events,
pushed over a plain HTTP stream. No WebSocket infrastructure, works through
proxies, consumable with the browser's `EventSource`, `curl`, or the client
SDK.

```
GET /api/v1/events/stream?topics=data.contacts.*,data.orders.created
Accept: text/event-stream
```

- **`topics`** — comma-separated [topic patterns](../concepts/events.md#topic-patterns)
  (`*` = one segment, `#` = zero or more). Defaults to `data.#` (every data
  event you're allowed to see).
- **Auth** — a session cookie or API key, like any other endpoint. When RBAC
  enforcement is on, unauthenticated connections get `401`, and each event is
  filtered per-connection: `data.<object>.<op>` requires `read` on that
  object; non-data topics require `read` on `events`. Events you lack
  permission for are silently skipped.

Each event arrives as one SSE frame (unnamed, so `EventSource.onmessage`
works) whose `data:` is the event envelope:

```
id: 4f7c2f6e-…
data: {"id":"4f7c2f6e-…","topic":"data.contacts.created","payload":{"object":"contacts","id":"…","op":"created","before":null,"after":{…},"diff":null,"actor":{"userId":"…","apiKeyId":null,"via":"session"}},"occurredAt":"2026-07-06T…"}
```

Comment frames (`: heartbeat`) flow every 15s to keep intermediaries from
idling the connection out.

## Semantics

Delivery is **best-effort from connect time**: nothing is replayed, nothing
is persisted per connection, and a dropped connection may miss events until
it reconnects. That is the right contract for live UI (feeds, dashboards,
cache invalidation). For side effects that must happen exactly once — audit
rows, emails, syncing another system — use a
[subscription](../concepts/events.md#subscribing) or an
[outbound webhook](../concepts/events.md#outbound-webhooks-phase-12) instead;
those ride the durable delivery ledger with retries.

## Client SDK

`@ion-drive/client` ships a zero-dependency consumer with automatic
reconnection (capped exponential backoff, `Last-Event-ID` forwarded):

```ts
import { IonDriveClient } from '@ion-drive/client';

const ion = new IonDriveClient({ baseUrl: 'http://localhost:3000', apiKey });

const stream = ion.events.stream(['data.contacts.*'], (event) => {
  console.log(event.topic, event.payload);
});

// later:
stream.close();
```

`stream()` also accepts `{ onConnect, onError, reconnect: false }` for
finer control.

## Browser (EventSource)

Cookie-authenticated pages (like the admin console's Events → Live feed tab)
can use the platform primitive directly:

```js
const source = new EventSource(
  '/api/v1/events/stream?topics=data.%23', // data.#
  { withCredentials: true },
);
source.onmessage = (message) => {
  const event = JSON.parse(message.data);
  console.log(event.topic, event.payload);
};
```

## curl

```bash
curl -N -H "x-api-key: iond_…" \
  "http://localhost:3000/api/v1/events/stream?topics=data.%23"
```

## Operations: the event ledger

The same route prefix carries the operational surface (RBAC resource
`events`):

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/events?topic=data.&limit=50` | Browse recent outbox events (newest first). |
| `GET /api/v1/events/deliveries?status=failed&consumer=webhook:<id>` | The delivery ledger joined to events — per-consumer history, errors, attempt counts. |
| `GET /api/v1/events/deliveries?dead=true` | Dead letters: failed deliveries whose retry budget is exhausted. |
| `POST /api/v1/events/deliveries/retry` `{ eventId, consumer }` | Reset a delivery's budget and redeliver immediately. |

The admin console's **Events** page wraps all of this (deliveries table with
filters + retry, live feed tab).
