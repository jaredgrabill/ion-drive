/**
 * Message-bus contract types.
 *
 * An **event** is an immutable {@link IonEvent} envelope (`id`/`topic`/`payload`
 * /`occurredAt`) published onto the bus. A **subscription** binds a topic
 * pattern to a named **consumer group** and a {@link BusHandler}; the bus
 * guarantees at-most-once delivery *per consumer group* (see ADR-015), so N
 * distinct consumers each react once even when M app instances are running.
 *
 * These are the pure contracts shared by publishers ({@link DataService}),
 * the bus implementation (`outbox-bus`/`dispatcher`), and plugins. The default
 * durable implementation is the Postgres transactional outbox in this module.
 */

import type { Kysely } from 'kysely';
import type { TenantDatabase } from '../db/types.js';
import type { LoggerProvider } from '../logging/logger-provider.js';

/** The immutable event envelope carried through the bus. */
export interface IonEvent<T = unknown> {
  /** Globally unique id; doubles as the idempotency key for consumers. */
  id: string;
  /** Dotted topic, e.g. `data.contacts.created`. */
  topic: string;
  payload: T;
  occurredAt: Date;
}

/** What a publisher supplies; `id`/`occurredAt` are filled in by the bus. */
export interface PublishInput<T = unknown> {
  topic: string;
  payload: T;
  id?: string;
  occurredAt?: Date;
}

/** The change operation a CRUD event describes. */
export type CrudOperation = 'created' | 'updated' | 'deleted';

/** Field-level change map: `{ field: { before, after } }`, system fields excluded. */
export type FieldDiff = Record<string, { before: unknown; after: unknown }>;

/** Payload of the `data.<object>.<op>` events emitted by {@link DataService}. */
export interface CrudEventPayload {
  object: string;
  id: string;
  op: CrudOperation;
  /** Full row before the change (null for creates). */
  before: Record<string, unknown> | null;
  /** Full row after the change (null for deletes). */
  after: Record<string, unknown> | null;
  /** System-field-free diff (only present for updates). */
  diff: FieldDiff | null;
}

/**
 * A subscription: a named consumer group reacting to a topic pattern via a
 * registered handler. Patterns match exact topics, a trailing `*`/`.*` prefix,
 * or per-segment `*` wildcards (e.g. `data.*.created`).
 */
export interface Subscription {
  /** Topic pattern to match. */
  topic: string;
  /** Consumer group — the unit of at-most-once delivery. */
  consumer: string;
  /** Name of the registered {@link BusHandler} that processes matched events. */
  handler: string;
  /** When true, every instance forms its own group (once-per-instance delivery). */
  perInstance?: boolean;
  /** Handler-specific configuration (e.g. the target object for `persist_event`). */
  config?: Record<string, unknown>;
  /** Optional provenance tag, e.g. the block that declared this subscription. */
  source?: string;
}

/** Runtime context handed to a {@link BusHandler} for one delivery. */
export interface EventContext {
  event: IonEvent;
  subscription: Subscription;
  /** Aborts when the delivery exceeds its timeout. */
  signal: AbortSignal;
  logger: LoggerProvider;
}

/** A pluggable unit of event-handling behaviour, referenced by `name`. */
export interface BusHandler {
  /** Discriminator referenced by {@link Subscription.handler}. */
  readonly name: string;
  readonly description: string;
  /** Processes one event. Throw to mark the delivery failed (it may be retried). */
  handle(ctx: EventContext): Promise<void>;
}

/** An inline handler function for the ergonomic {@link MessageBus.on} helper. */
export type EventHandlerFn = (
  event: IonEvent,
  ctx: { signal: AbortSignal; logger: LoggerProvider },
) => Promise<void> | void;

/** Options for {@link MessageBus.on}. */
export interface SubscribeOptions {
  perInstance?: boolean;
  source?: string;
}

/**
 * A Kysely handle usable for a transactional publish. Passing the same
 * transaction the caller used for its write makes the outbox insert atomic
 * with the business write (no dual-write gap). A `Transaction` is assignable
 * here since it extends `Kysely`.
 */
export type BusTransaction = Kysely<TenantDatabase>;
