/**
 * Messaging module barrel — the message bus contract, its default Postgres
 * transactional-outbox implementation, the dispatcher, built-in handlers, and
 * the change-diff helper (see ADR-015).
 */

export type {
  IonEvent,
  PublishInput,
  CrudOperation,
  CrudEventPayload,
  FieldDiff,
  LinkOperation,
  LinkEventPayload,
  Subscription,
  BusHandler,
  EventContext,
  EventHandlerFn,
  SubscribeOptions,
  BusTransaction,
} from './event-types.js';

export type { MessageBus } from './message-bus.js';
export { MESSAGE_BUS } from './message-bus.js';

export { computeDiff } from './diff.js';
export { topicMatches, topicLikePrefix } from './topic-match.js';

export { EventStore, bootstrapEventTables } from './event-store.js';
export type { EventRow, CandidateQuery, DeliveryRow, RetryBackoff } from './event-store.js';

export { OutboxBus } from './outbox-bus.js';
export { NoopBus } from './noop-bus.js';
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF,
  EventDispatcher,
} from './dispatcher.js';
export type { EventDispatcherOptions } from './dispatcher.js';

export { logEventHandler, createPersistEventHandler } from './handlers.js';
export type { RecordWriter } from './handlers.js';

// Realtime bridge + outbound webhooks (Phase 12 / ADR-019)
export { RealtimeBridge } from './realtime.js';
export type { RealtimeBridgeOptions, RealtimeListener } from './realtime.js';
export {
  WEBHOOK_CONSUMER_PREFIX,
  WEBHOOK_HANDLER_NAME,
  WEBHOOK_SIGNATURE_HEADER,
  WebhookError,
  WebhookManager,
  WebhookStore,
  bootstrapWebhookTable,
  generateWebhookSecret,
  signWebhookPayload,
} from './webhooks.js';
export type {
  CreatedWebhook,
  WebhookInput,
  WebhookManagerOptions,
  WebhookRow,
  WebhookView,
} from './webhooks.js';
