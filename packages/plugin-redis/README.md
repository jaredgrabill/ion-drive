# @ion-drive/plugin-redis

Redis infrastructure for [Ion Drive](https://github.com/jaredgrabill/ion-drive): a
Redis-backed **cache** (default on) and an opt-in **Redis Streams message bus**.

## Install

```bash
npm install @ion-drive/plugin-redis
```

Programmatic (recommended — your `server.ts` composition root):

```ts
import { createServer, loadConfig } from '@ion-drive/core';
import { redisPlugin } from '@ion-drive/plugin-redis';

const server = await createServer(loadConfig(), {
  plugins: [redisPlugin({ url: 'redis://localhost:6379' })],
});
```

Or via environment: `ION_PLUGINS=@ion-drive/plugin-redis` with `ION_REDIS_URL`
(or `REDIS_URL`).

## Cache (default on)

Swaps core's in-process `MemoryCache` for Redis under the `CACHE_SERVICE`
token — coherent across instances. Values are JSON-serialized; keys live under
`<keyPrefix>cache:` (default `ion:cache:`) so `clear()` only touches this
cache. Disable with `redisPlugin({ cache: false })`.

## Message bus (opt-in: `ION_REDIS_BUS=true` or `{ bus: true }`)

Replaces the Postgres transactional-outbox bus with a Redis Stream
(`<keyPrefix>events`) plus a consumer-group dispatcher. **Read this before
enabling — you are trading guarantees:**

| | Outbox (default) | Redis Streams (this plugin) |
|---|---|---|
| Publish vs. DB commit | Atomic (same transaction) | Not atomic — an event can be emitted for a transaction that rolls back |
| Delivery | At-least-once, once per consumer group across instances | Same (Redis groups + `XCLAIM` arbitrate) |
| Retries | 5 attempts, 5s×2ⁿ backoff (cap 5 min) | Same schedule, via pending-list delivery counts |
| Dead letters | `_ion_event_deliveries` rows + `/api/v1/events` DLQ UI | `<keyPrefix>events:dlq` stream (inspect with `XRANGE`) |
| `/api/v1/events` ledger + realtime SSE | Available | **Off** (they read the outbox directly) |
| Webhooks, block subscriptions, `ion.event.*` metrics | Available | Preserved |

Handlers must be idempotent on `event.id` — that was already the platform
contract. The bus honors `ION_EVENTS_ENABLED=false` (no swap).

## Options

`redisPlugin({ url, keyPrefix, cache, bus, streamMaxLen, pollIntervalMs,
batchSize, maxAttempts, handlerTimeoutMs, dlqMaxLen })` — see the JSDoc on
`RedisPluginOptions` for details and defaults.

## License

Apache-2.0 © IonShift Technologies LLC
