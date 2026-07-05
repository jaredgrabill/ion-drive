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
export type { EventRow, CandidateQuery } from './event-store.js';

export { OutboxBus } from './outbox-bus.js';
export { NoopBus } from './noop-bus.js';
export { EventDispatcher } from './dispatcher.js';
export type { EventDispatcherOptions } from './dispatcher.js';

export { logEventHandler, createPersistEventHandler } from './handlers.js';
export type { RecordWriter } from './handlers.js';
