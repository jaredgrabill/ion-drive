/**
 * OutboxBus — the default {@link MessageBus}, backed by the Postgres outbox.
 *
 * `publish` writes an event into `_ion_events` (optionally inside the caller's
 * transaction, for the atomic transactional-outbox guarantee). Delivery to
 * subscribers is performed asynchronously by the {@link EventDispatcher}, which
 * reads this bus's handler registry and subscription list — so publishing never
 * blocks on consumers. Handlers are keyed by name (the `TaskRunner` registry
 * pattern) and subscriptions fan out across consumer groups. See ADR-015.
 */

import { randomUUID } from 'node:crypto';
import { recordEventPublished } from '../telemetry/metrics.js';
import type { EventStore } from './event-store.js';
import type {
  BusHandler,
  BusTransaction,
  EventContext,
  EventHandlerFn,
  IonEvent,
  PublishInput,
  SubscribeOptions,
  Subscription,
} from './event-types.js';
import type { MessageBus } from './message-bus.js';

export class OutboxBus implements MessageBus {
  private readonly handlers = new Map<string, BusHandler>();
  private readonly subscriptions: Subscription[] = [];
  private wakeHandler?: () => void;
  private inlineSeq = 0;

  constructor(private readonly store: EventStore) {}

  async publish<T>(event: PublishInput<T>, trx?: BusTransaction): Promise<void> {
    const envelope: IonEvent<T> = {
      id: event.id ?? randomUUID(),
      topic: event.topic,
      payload: event.payload,
      occurredAt: event.occurredAt ?? new Date(),
    };
    await this.store.insert(envelope, trx);
    recordEventPublished(envelope.topic);
    // When published standalone (no caller transaction) the row is already
    // committed, so nudge the dispatcher; inside a transaction the caller wakes
    // us after it commits.
    if (!trx) this.wake();
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
    for (let i = this.subscriptions.length - 1; i >= 0; i -= 1) {
      if (this.subscriptions[i]?.consumer === consumer) this.subscriptions.splice(i, 1);
    }
  }

  wake(): void {
    this.wakeHandler?.();
  }

  // --- Concrete surface used by the dispatcher (not part of the port) ---

  /** Resolves a handler by name for the dispatcher. */
  getHandler(name: string): BusHandler | undefined {
    return this.handlers.get(name);
  }

  /** Registers the dispatcher's drain callback, invoked by {@link wake}. */
  setWakeHandler(handler: () => void): void {
    this.wakeHandler = handler;
  }
}
