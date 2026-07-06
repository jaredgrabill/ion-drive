# Phase 9 — Extensibility Core: Plugin Architecture, Message Bus & Auditing

> **Status:** ✅ Done — 2026-07-05. Verified: all-package typecheck clean; 115 core + 9 blocks unit tests pass; 9/9 live audit smoke checks pass on Postgres; Biome clean (only pre-existing complexity warnings).
>
> | Track | Scope | Status |
> |:---|:---|:---|
> | A | Runtime & providers (registry, plugin host, cache/email/logger ports, config) | ✅ Done (18 unit tests) |
> | B | Message bus (outbox, dispatcher, diff, handlers) | ✅ Done (26 unit tests; SQL paths verified in the live smoke) |
> | C | DataService integration & blocks (CRUD events, `subscriptions`, audit block) | ✅ Done (5 DataService tests + live audit smoke: 9/9 checks on Postgres) |
> | D | Wiring, docs & ADR (`server.ts`, exports, concept docs) | ✅ Done (`docs/concepts/{events,plugins}.md`, ADR-015, CLAUDE.md status) |

> **Goal:** Make Ion Drive extensible **without forking core**. Introduce (1) a lightweight service registry so out-of-repo plugins can seamlessly *replace* infrastructure implementations (cache, email, message bus), (2) a durable **message bus** so events flow through the system with loose coupling, (3) **CRUD change events** carrying the row plus a system-field-free diff, and (4) an **audit log** delivered as a building block that consumes those events exactly once per change. Success = a Redis plugin swaps the in-process bus/cache with no core edits, and installing the `audit` block records every data change automatically.

> [!IMPORTANT]
> This is an open source project. Every component, service, and utility added in this phase must meet the same standards as the existing `packages/core` codebase: **top-of-file JSDoc**, **strict TypeScript**, **Biome-clean**, **tested** (`*.test.ts` beside the module), and **documented**. See [CLAUDE.md](../CLAUDE.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).

See **[ADR-015](research/architecture-decisions.md)** for the decision record and rationale behind everything below.

---

## Resolved Decisions

| Area | Decision |
|:---|:---|
| **Registry / DI** | Lightweight in-house `ServiceRegistry` + `definePlugin({ name, setup(ctx) })` host. No awilix/inversify — extends the `AuthProvider` port precedent (ADR-010) and the dependency-light ethos (ADR-012). |
| **Bus durability** | Postgres **transactional outbox** (`_ion_events`) written in the same transaction as the CRUD write. In-process dispatcher relays to subscribers; Redis adapter can relay from the same outbox later. |
| **Delivery model** | **Named consumer groups**, at-most-once *per group*, via `SELECT … FOR UPDATE SKIP LOCKED` on `_ion_event_deliveries`. `perInstance` flag toggles cluster-once (default) vs once-per-instance. No broker required. |
| **Audit identity** | **Deferred.** Only `created_at`/`updated_at`; event payload is `{ object, id, op, before, after, diff }` with no `actorId`. `created_by`/`updated_by` + actor threading are a later pass (`changed_by` column stubbed for forward-compat). |
| **Audit POC** | An **`audit` building block** in `@ion-drive/blocks`: declares an `audit_log` object + a `data.*.{created,updated,deleted}` subscription handled by a generic built-in `persist_event` handler. |

---

## Architecture Overview

```
createServer()
  ├─ build ServiceRegistry
  ├─ register DEFAULTS   (MemoryCache, LogEmailProvider, OutboxBus(tenantDb), logger)
  ├─ loadPlugins()       (ION_PLUGINS + programmatic) → plugins may registry.set(...) to OVERRIDE
  ├─ resolve bus         ← registry
  ├─ new DataService(tenantDb, registry, bus)      // emits data.<object>.<op> in-txn
  ├─ new BlockEngine(..., { bus })                 // re-registers block subscriptions on boot
  ├─ EventDispatcher.start()                       // drains _ion_events → consumer groups
  └─ shutdown: dispatcher.drainAndStop() + plugin.onShutdown()

CRUD write + event row  →  ONE db transaction  (no dual-write gap)
        │
   _ion_events (outbox) ──► dispatcher ──► in-process subscribers (default)
                                     └───► Redis Streams (when plugin loaded)
   each named consumer = a group ⇒ N consumer types each fire once, even with M app instances
```

---

## Work Breakdown

Four largely-parallel tracks. A defines the tokens/interfaces others depend on; D integrates last.

### Track A — Runtime & providers · **1 agent (foundational)**

#### [NEW] `packages/core/src/runtime/`
| File | Purpose |
|:---|:---|
| `service-registry.ts` | Keyed singleton container: `set/get/has/require`, last-write-wins so plugin overrides replace defaults. Typed tokens (`'cache'`, `'email'`, `'bus'`, `'logger'`). |
| `plugin.ts` | `definePlugin`, `IonPlugin`, `PluginContext` (`{ registry, config, logger, bus, tasks, blocks }`), `loadPlugins(specifiers, ctx)` (programmatic + `ION_PLUGINS` dynamic `import()`), lifecycle collection (`onReady`/`onShutdown`). |
| `service-registry.test.ts`, `plugin.test.ts` | Default resolves; later `set` wins; `require` throws; `setup` runs in order and overrides take effect. |

#### [NEW] provider ports + defaults
| File | Purpose |
|:---|:---|
| `packages/core/src/cache/{cache-provider.ts, memory-cache.ts, memory-cache.test.ts}` | `CacheProvider` port (`get/set/delete/has`, TTL) + in-memory default with expiry sweep. |
| `packages/core/src/email/{email-provider.ts, log-email.ts, log-email.test.ts}` | `EmailProvider` port (`send(message)`) + logging default ("no email provider configured"). |
| `packages/core/src/logging/logger-provider.ts` | Thin `LoggerProvider` token delegating to the **existing** pino/OTel `server.log` (no behaviour change; makes the sink swappable). |

#### [EDIT] `packages/core/src/config/index.ts`
| Change | Purpose |
|:---|:---|
| `plugins` (`ION_PLUGINS`, comma-sep), `eventsEnabled` (`ION_EVENTS_ENABLED`, default on), dispatcher poll interval | New config, following the `envBoolean`/`ION_*` convention. |

### Track B — Message bus · **1 agent** (depends on A's tokens)

#### [NEW] `packages/core/src/messaging/`
| File | Purpose |
|:---|:---|
| `event-types.ts` | `IonEvent` envelope `{ id, topic, payload, occurredAt }`; CRUD payload `{ object, id, op, before, after, diff }`; `Subscription` type. |
| `diff.ts` (+ test) | `computeDiff(before, after)` → shallow `{ field: { before, after } }` **excluding `SYSTEM_MANAGED_COLUMNS`** (`created_at`/`updated_at`/future `*_by`). |
| `event-store.ts` | Bootstraps `_ion_events` (id, topic, payload jsonb, occurred_at) + `_ion_event_deliveries` (event_id, consumer_group, status, attempts, error, processed_at; PK `(event_id, consumer_group)`) in the **tenant DB**. |
| `outbox-bus.ts` (+ test) | `implements MessageBus`: `publish(event, trx)` inserts into `_ion_events` inside the caller's txn; `subscribe(sub)` registers in a `Map` (TaskRunner-registry pattern, array fan-out); topic matching (exact / prefix / `*` wildcard segments). |
| `dispatcher.ts` (+ test) | `EventDispatcher`: nudged after commit + short poll fallback; claims each `(event, consumer_group)` via `SKIP LOCKED`, runs the handler under timeout (reusing TaskRunner's abort/timeout + span/metric), marks delivered, idempotent on `event.id`; `perInstance` → group suffixed with instance id. |
| `handlers.ts` (+ test) | Built-in bus handlers `log_event` and `persist_event` (writes envelope into a configured object via `DataService`). |
| `index.ts` | Barrel: `MessageBus` port, `OutboxBus`, `EventDispatcher`, event types, `computeDiff`, built-in handlers. |

### Track C — DataService integration & blocks · **1 agent** (depends on B)

#### [EDIT] `packages/core/src/data/data-service.ts`
| Change | Purpose |
|:---|:---|
| Optional `bus` injected; wrap `create/update/delete/bulkCreate/bulkDelete` in `this.db.transaction()` | Atomic CRUD + `bus.publish(event, trx)`; **no-op when bus absent** (telemetry `record*` convention). |
| `update` reads before-image in-txn; `delete`/`bulkDelete` use `DELETE … RETURNING`; `bulkCreate` `returning('id')`→`returningAll()` | Provide `before`/`after` for the diff and per-row events. |
| Emit `data.<object>.<op>` | Change-event stream for all surfaces (REST/GraphQL/MCP unchanged — events are additive). |

#### [EDIT] `packages/core/src/blocks/`
| File | Change |
|:---|:---|
| `block-types.ts` | Add `subscriptions?: [{ event, consumer, handler, mode?, perInstance?, config? }]` to `blockManifestSchema` + `toSubscriptionInput` bridge; consistency check that `handler` is a registered bus handler. |
| `block-installer.ts` | 6th ordered step `applySubscriptions` (idempotent, reported); `uninstall` removes them. |
| `index.ts` (`BlockEngine`) | Inject bus via `BlockEngineServices`; on `initialize()` re-register installed blocks' subscriptions from the `_ion_blocks` manifest snapshot. |

#### [NEW] audit block — `packages/blocks/`
| File | Purpose |
|:---|:---|
| `src/blocks/audit.ts` | `audit_log` object (`object_name`, `record_id`, `operation`, `diff` jsonb, `snapshot` jsonb, `event_id`, `changed_by` nullable) + one subscription `{ event: 'data.*', consumer: 'audit', handler: 'persist_event', config: { object: 'audit_log', … } }`. |
| `src/registry.ts`, `blocks/audit/block.json` | Register in `blockRegistry`/`blockSummaries`; emit `block.json`; `manifests.test.ts` drift guard covers it. |

### Track D — Wiring, docs & ADR · **1 agent (integrates A–C)**

#### [EDIT] `packages/core/src/server.ts`
Build registry → register defaults → `loadPlugins` → resolve bus → `new DataService(..., bus)` → pass bus to `BlockEngine` → construct + `start()` `EventDispatcher` after routes → drain+stop dispatcher and run plugin `onShutdown` in graceful shutdown.

#### [EDIT] `packages/core/src/index.ts`
Export `ServiceRegistry`, `definePlugin`, `IonPlugin`, `PluginContext`, `MessageBus`, `CacheProvider`, `EmailProvider`, event types, `computeDiff`.

#### [NEW/EDIT] docs
| File | Purpose |
|:---|:---|
| `docs/research/architecture-decisions.md` | **ADR-015** (done). |
| `docs/concepts/plugins.md` | How to write/load a plugin; provider ports and tokens; override example. |
| `docs/concepts/events.md` | Topics, subscriptions, consumer groups, `perInstance`, the outbox/deliveries model, delivery guarantees. |
| `CLAUDE.md`, `docs/implementation_plan.md` | Status update when the phase lands. |

---

## Reuse (don't reinvent)

- **Handler registry** — copy `TaskRunner`'s `Map`-keyed register/replace/dispatch + abort/timeout + span/metric approach (`tasks/task-runner.ts`) for bus handlers and the dispatcher.
- **Port/adapter shape** — model providers on `AuthProvider` (`auth/types.ts`) + `better-auth-adapter.ts`.
- **Options-bag DI** — follow `BlockEngineServices` / `TaskEngineOptions` for injecting the bus/registry.
- **No-op-when-disabled** — mirror the telemetry `record*` helpers so an absent bus costs nothing.
- **System fields** — `SYSTEM_FIELDS` / a new `SYSTEM_MANAGED_COLUMNS` in `schema/types.ts` is the single source for diff exclusion.
- **Config** — `envBoolean` + `ION_*` fallbacks in `config/index.ts`.

---

## Verification Plan

### Automated tests (`pnpm --filter @ion-drive/core test`)
- **Registry:** default resolves; later `set` (plugin override) wins; `require` throws on missing token.
- **Plugin host:** `loadPlugins` runs `setup` in order; an override registered in `setup` is what dependents resolve.
- **`computeDiff`:** changed/added/removed fields captured; `created_at`/`updated_at`/`*_by` **never** appear.
- **Topic matching:** exact, prefix, `*` wildcard segments; non-match excluded.
- **`OutboxBus.publish`:** writes an `_ion_events` row inside the passed transaction; rollback ⇒ no event.
- **`EventDispatcher`:** two dispatchers over the same `_ion_events` process each `(event, consumer)` **exactly once** (SKIP LOCKED); redelivery on handler failure idempotent by `event.id`; `perInstance` yields one delivery per instance.
- **Block manifest:** `subscriptions` parses; unknown `handler` rejected at install; `manifests.test.ts` drift guard passes for the audit block.

### Key test scenarios (live smoke, Postgres · `pnpm test:integration`)
1. Install the `audit` block. `POST` a record ⇒ exactly **one** `audit_log` row (`operation=created`, full snapshot). `PATCH` ⇒ one `updated` row whose `diff` contains only the changed business field (**no `updated_at`**). `DELETE` ⇒ one `deleted` row carrying the before-image.
2. Two dispatcher instances against one DB, batch of writes ⇒ **no duplicate** audit rows (cluster-once per consumer group).
3. A throwaway `definePlugin` that `registry.set('cache', …)` ⇒ platform resolves the override (proves seamless swap).

### Manual verification
- `pnpm typecheck` and `pnpm lint:fix` clean across `core`/`blocks`.
- Boot with `ION_EVENTS_ENABLED=false` ⇒ CRUD unaffected, no events emitted (no-op path).
- (Pre-existing) root `pnpm test` still fails only on `packages/admin` having no test files — unrelated.

---

## Out of Scope (follow-ups)
- Concrete external plugin repos: `@ion-drive/plugin-redis` (cache + Streams bus), `plugin-sendgrid`, `plugin-rabbitmq` — this phase proves the seams with in-core defaults + one reference override.
- `created_by`/`updated_by` and actor-identity threading through `DataService` and the REST/GraphQL/MCP surfaces (`changed_by` column stubbed now).
- Redis Streams consumer-group adapter (the outbox + deliveries model maps onto it directly).
- GIN/pg_trgm search, cross-datacenter/low-latency fan-out (Redis adapter's job, behind the same `MessageBus` port).
