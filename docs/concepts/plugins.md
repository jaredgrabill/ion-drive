# Plugins

Plugins extend Ion Drive **without forking core**. A plugin is a small npm
package that, at boot, can **replace** an infrastructure service (cache, email,
message bus, logger) or **hook into events**. Swapping the in-memory cache for
Redis, or the log-only email provider for SendGrid, is a matter of installing a
package and naming it — no core edits.

This is the same idea as a Spring Boot autoconfiguration or an Express plugin,
kept deliberately lightweight (see [ADR-015](../research/architecture-decisions.md)).

> **Plugins vs. building blocks.** A [building block](./building-blocks.md) adds
> *business* schema (objects, seed data, tasks) you own and edit. A **plugin**
> swaps *infrastructure* implementations you don't want to hand-manage. Cache,
> email, and the message-bus transport are plugins; a CRM is a block.

## Provider ports

Core defines a small interface (a **port**) for each swappable service and ships
a default implementation, registered in a **service registry** under a typed
token. A plugin overrides a service by registering a different implementation
under the same token — last write wins.

| Token | Port | Default | Example plugin |
|---|---|---|---|
| `CACHE_SERVICE` | `CacheProvider` | in-memory `MemoryCache` | Redis |
| `EMAIL_SERVICE` | `EmailProvider` | `LogEmailProvider` (logs only) | SendGrid / SMTP |
| `MESSAGE_BUS` | `MessageBus` | Postgres outbox `OutboxBus` | Redis Streams |
| `LOGGER_SERVICE` | `LoggerProvider` | pino + OpenTelemetry | — |

Anywhere in core or a block that needs a service resolves it from the registry,
so it transparently uses whatever a plugin installed.

## Writing a plugin

A plugin is an object with a `name` and a `setup` hook (plus optional `onReady`
/ `onShutdown`). Use `definePlugin` for authoring-time type-checking:

```ts
import { definePlugin, CACHE_SERVICE } from '@ionshift/ion-drive-core';
import { RedisCache } from './redis-cache.js';

export default definePlugin({
  name: 'redis',
  setup(ctx) {
    // Replace the default cache — everything now caches in Redis.
    ctx.registry.set(CACHE_SERVICE, new RedisCache(ctx.config));
  },
  async onShutdown() {
    // release connections…
  },
});
```

The `setup` context gives you:

- `registry` — resolve or replace services (`ctx.registry.set(TOKEN, impl)`).
- `config` — the validated server configuration.
- `logger` — the platform logger, tagged with your plugin name.
- `bus` — the [message bus](./events.md): subscribe to events or register
  handlers.

`setup` runs **after core registers its defaults but before the services that
consume them are built**, so an override takes effect everywhere.

## Loading plugins

Plugins are loaded from an explicit list — nothing is auto-discovered by
scanning:

- **Env:** `ION_PLUGINS=@ion-drive/plugin-redis,@acme/ion-audit` — a
  comma-separated list of module specifiers, each dynamically imported (its
  default export must be a plugin).
- **Programmatic:** `createServer(config, { plugins: [redis, sendgrid] })`.

Later entries win, so an in-code plugin can override one loaded from the env.

## Subscribing to events from a plugin

Because `ctx.bus` is the real bus, a plugin can react to any change:

```ts
export default definePlugin({
  name: 'cache-buster',
  setup(ctx) {
    // Fire on every instance (perInstance) to clear each node's local cache.
    ctx.bus.on(
      'data.#',
      'cache-buster',
      async (event) => {
        const p = event.payload as { object: string; id: string };
        await ctx.registry.require(CACHE_SERVICE).delete(`${p.object}:${p.id}`);
      },
      { perInstance: true },
    );
  },
});
```

See [Events & the Message Bus](./events.md) for topic patterns and delivery
guarantees.

## What core provides out of the box

You can build real applications with **no plugins at all** — the defaults are
fully functional: an in-memory cache, a durable Postgres-backed message bus, and
OpenTelemetry logging. Plugins are for when you outgrow single-node defaults or
want a specific vendor.
