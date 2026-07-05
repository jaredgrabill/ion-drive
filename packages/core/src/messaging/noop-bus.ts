/**
 * NoopBus — the {@link MessageBus} used when events are disabled
 * (`ION_EVENTS_ENABLED=false`).
 *
 * Every method is inert, so publishers (notably {@link DataService}) can depend
 * on a bus unconditionally and never null-check. This mirrors the telemetry
 * `record*` helpers, which are no-ops when the SDK is off. Subscriptions
 * registered against it simply never fire.
 */

import type {
  BusHandler,
  EventHandlerFn,
  PublishInput,
  SubscribeOptions,
  Subscription,
} from './event-types.js';
import type { MessageBus } from './message-bus.js';

export class NoopBus implements MessageBus {
  async publish<T>(_event: PublishInput<T>): Promise<void> {}
  subscribe(_subscription: Subscription): void {}
  on(
    _topic: string,
    _consumer: string,
    _handle: EventHandlerFn,
    _options?: SubscribeOptions,
  ): void {}
  registerHandler(_handler: BusHandler): void {}
  hasHandler(_name: string): boolean {
    return false;
  }
  listSubscriptions(): Subscription[] {
    return [];
  }
  unsubscribeConsumer(_consumer: string): void {}
  wake(): void {}
}
