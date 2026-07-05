/**
 * The {@link MessageBus} port.
 *
 * Publishers and plugins depend only on this interface; the default
 * implementation is the Postgres transactional outbox (`OutboxBus`), and an
 * out-of-repo Redis Streams adapter can implement the same contract without any
 * change to callers (see ADR-015). The registry token here is how a plugin
 * swaps the implementation.
 */

import { serviceToken } from '../runtime/service-registry.js';
import type {
  BusHandler,
  BusTransaction,
  EventHandlerFn,
  PublishInput,
  SubscribeOptions,
  Subscription,
} from './event-types.js';

/** Loosely-coupled publish/subscribe with named consumer groups. */
export interface MessageBus {
  /**
   * Publishes an event. When `trx` is supplied the event is written inside that
   * transaction (transactional outbox — atomic with the caller's write);
   * otherwise it is persisted on its own connection.
   */
  publish<T>(event: PublishInput<T>, trx?: BusTransaction): Promise<void>;

  /** Registers a declarative subscription (handler referenced by name). */
  subscribe(subscription: Subscription): void;

  /** Ergonomic helper: registers an inline handler and subscribes to it at once. */
  on(topic: string, consumer: string, handle: EventHandlerFn, options?: SubscribeOptions): void;

  /** Registers (or replaces) a named handler that subscriptions can reference. */
  registerHandler(handler: BusHandler): void;

  /** Whether a handler name is registered (used to validate block subscriptions). */
  hasHandler(name: string): boolean;

  /** The currently-registered subscriptions. */
  listSubscriptions(): Subscription[];

  /** Removes every subscription belonging to a consumer group (e.g. on uninstall). */
  unsubscribeConsumer(consumer: string): void;

  /**
   * Signals that new events may be available (called by a publisher once its
   * transaction has committed) so the dispatcher can drain immediately instead
   * of waiting for its next poll. A no-op on buses that don't dispatch.
   */
  wake(): void;
}

/** Registry token for the platform message bus. */
export const MESSAGE_BUS = serviceToken<MessageBus>('bus');
