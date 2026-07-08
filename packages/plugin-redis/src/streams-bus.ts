/**
 * RedisStreamsBus — a {@link MessageBus} backed by a Redis Stream instead of
 * the Postgres outbox.
 *
 * `publish` XADDs the event envelope onto one stream (`<prefix>events`,
 * approximate-MAXLEN-trimmed); the {@link RedisDispatcher} drains it to
 * subscribers via one Redis consumer group per Ion consumer group, which
 * preserves the platform guarantee of **once per consumer group across
 * instances** (Redis arbitrates instead of a Postgres upsert).
 *
 * Semantics vs. the outbox — deliberate trade-offs, documented in the README:
 *  - No transactional publish: the `trx` argument is accepted (the port
 *    requires it) but the event goes to Redis immediately, so an event can be
 *    emitted for a database transaction that later rolls back, and delivery is
 *    at-least-once. Handlers must already be idempotent on `event.id`.
 *  - The `_ion_events` ledger surfaces (`/api/v1/events`, realtime SSE, DLQ
 *    admin) are outbox readers and turn off when this bus is installed; the
 *    dead-letter stream `<prefix>events:dlq` takes over the DLQ role.
 *
 * The handler/subscription registry mirrors core's OutboxBus exactly so block
 * subscriptions, webhooks, and built-in handlers behave identically.
 */

import { randomUUID } from 'node:crypto';
import {
  type BusHandler,
  type BusTransaction,
  type EventContext,
  type EventHandlerFn,
  type IonEvent,
  type MessageBus,
  type PublishInput,
  type SubscribeOptions,
  type Subscription,
  recordEventPublished,
} from '@ion-drive/core';
import type { RedisApi } from './redis-api.js';

/** Default approximate cap on the event stream (entries, not bytes). */
export const DEFAULT_STREAM_MAX_LEN = 100_000;

export interface RedisStreamsBusOptions {
  /** Key prefix shared by the plugin (default `ion:`). */
  keyPrefix?: string;
  /** Approximate MAXLEN the event stream is trimmed to. */
  streamMaxLen?: number;
}

/** Serializes an event envelope into stream fields (all strings). */
export function eventToFields(event: IonEvent<unknown>): Record<string, string> {
  return {
    id: event.id,
    topic: event.topic,
    payload: JSON.stringify(event.payload ?? null),
    occurredAt: event.occurredAt.toISOString(),
  };
}

/** Rehydrates an event envelope from stream fields (inverse of {@link eventToFields}). */
export function eventFromFields(fields: Record<string, string>): IonEvent<unknown> | undefined {
  const { id, topic, payload, occurredAt } = fields;
  if (!id || !topic || payload === undefined || !occurredAt) return undefined;
  try {
    return { id, topic, payload: JSON.parse(payload), occurredAt: new Date(occurredAt) };
  } catch {
    return undefined;
  }
}

export class RedisStreamsBus implements MessageBus {
  readonly streamKey: string;
  readonly dlqKey: string;

  private readonly streamMaxLen: number;
  private readonly handlers = new Map<string, BusHandler>();
  private readonly subscriptions: Subscription[] = [];
  private readonly wakeHandlers = new Set<() => void>();
  private inlineSeq = 0;

  constructor(
    private readonly redis: RedisApi,
    options: RedisStreamsBusOptions = {},
  ) {
    const prefix = options.keyPrefix ?? 'ion:';
    this.streamKey = `${prefix}events`;
    this.dlqKey = `${prefix}events:dlq`;
    this.streamMaxLen = options.streamMaxLen ?? DEFAULT_STREAM_MAX_LEN;
  }

  async publish<T>(event: PublishInput<T>, _trx?: BusTransaction): Promise<void> {
    const envelope: IonEvent<T> = {
      id: event.id ?? randomUUID(),
      topic: event.topic,
      payload: event.payload,
      occurredAt: event.occurredAt ?? new Date(),
    };
    // `_trx` is ignored — see the module doc: Redis cannot join a Postgres
    // transaction, so publishes are immediate and at-least-once.
    await this.redis.addToStream(this.streamKey, eventToFields(envelope), this.streamMaxLen);
    recordEventPublished(envelope.topic);
    this.wake();
  }

  subscribe(subscription: Subscription): void {
    this.subscriptions.push(subscription);
  }

  on(topic: string, consumer: string, handle: EventHandlerFn, options?: SubscribeOptions): void {
    this.inlineSeq += 1;
    const name = `__inline_${this.inlineSeq}`;
    this.registerHandler({
      name,
      description: `inline handler for consumer "${consumer}"`,
      handle: (ctx: EventContext) =>
        Promise.resolve(handle(ctx.event, { signal: ctx.signal, logger: ctx.logger })),
    });
    this.subscribe({
      topic,
      consumer,
      handler: name,
      perInstance: options?.perInstance,
      source: options?.source,
    });
  }

  registerHandler(handler: BusHandler): void {
    this.handlers.set(handler.name, handler);
  }

  hasHandler(name: string): boolean {
    return this.handlers.has(name);
  }

  listSubscriptions(): Subscription[] {
    return [...this.subscriptions];
  }

  unsubscribeConsumer(consumer: string): void {
    // The Redis consumer group is deliberately left in place: destroying it
    // would drop pending (unacknowledged) deliveries, and re-subscribing later
    // resumes cleanly from the group's cursor.
    for (let i = this.subscriptions.length - 1; i >= 0; i -= 1) {
      if (this.subscriptions[i]?.consumer === consumer) this.subscriptions.splice(i, 1);
    }
  }

  wake(): void {
    for (const handler of this.wakeHandlers) handler();
  }

  // --- Concrete surface used by the RedisDispatcher (not part of the port) ---

  /** Resolves a handler by name for the dispatcher. */
  getHandler(name: string): BusHandler | undefined {
    return this.handlers.get(name);
  }

  /** Registers a drain callback invoked by {@link wake}. */
  setWakeHandler(handler: () => void): void {
    this.wakeHandlers.add(handler);
  }
}
