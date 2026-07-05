/**
 * Built-in bus handlers — the event equivalents of the built-in task handlers.
 *
 *  - `log_event` logs a matched event (handy for debugging subscriptions).
 *  - `persist_event` writes the event into a configured data object, mapping
 *    event/payload tokens onto columns. This is the generic mechanism the audit
 *    building block uses to record every change, keeping core content-agnostic —
 *    there is no audit-specific logic in core (see ADR-015).
 *
 * `persist_event` writes through a {@link RecordWriter} rather than depending on
 * `DataService` directly, so this module stays decoupled and the writer can
 * suppress re-emission (avoiding an audit-of-audit event loop).
 */

import type { BusHandler, IonEvent } from './event-types.js';

/** A minimal write sink for {@link createPersistEventHandler}. */
export interface RecordWriter {
  /** Inserts a row into a data object. Should NOT re-emit a change event. */
  insert(object: string, data: Record<string, unknown>): Promise<void>;
}

/** Logs the matched event. */
export const logEventHandler: BusHandler = {
  name: 'log_event',
  description: 'Logs the matched event (debugging aid for subscriptions).',
  async handle(ctx) {
    ctx.logger.info(`event ${ctx.event.topic}`, { eventId: ctx.event.id });
  },
};

/** Config accepted by the `persist_event` handler (from a subscription). */
interface PersistEventConfig {
  /** Target data object to write the row into. */
  object?: string;
  /** Column → token map; tokens are resolved from the event/payload. */
  map?: Record<string, string>;
}

/**
 * Creates the `persist_event` handler bound to a writer. Each subscription
 * supplies `config: { object, map }`; every `map` value is either a known token
 * (see {@link resolveToken}) or a literal string.
 */
export function createPersistEventHandler(writer: RecordWriter): BusHandler {
  return {
    name: 'persist_event',
    description:
      'Persists the event into a data object. config: { object, map: { column: token } }.',
    async handle(ctx) {
      const config = ctx.subscription.config as PersistEventConfig | undefined;
      if (!config?.object) {
        throw new Error('persist_event requires a "object" in the subscription config');
      }
      const row: Record<string, unknown> = {};
      for (const [column, token] of Object.entries(config.map ?? {})) {
        row[column] = resolveToken(token, ctx.event);
      }
      await writer.insert(config.object, row);
    },
  };
}

/**
 * Resolves a mapping token against an event. Recognised tokens read from the
 * envelope or the (CRUD) payload; `payload.record` is the after-image falling
 * back to the before-image (so deletes still capture a snapshot). Anything else
 * is treated as a literal value.
 */
function resolveToken(token: string, event: IonEvent): unknown {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (token) {
    case 'event.id':
      return event.id;
    case 'event.topic':
      return event.topic;
    case 'event.occurredAt':
      return event.occurredAt;
    case 'payload.object':
      return payload.object;
    case 'payload.id':
      return payload.id;
    case 'payload.op':
      return payload.op;
    case 'payload.before':
      return payload.before;
    case 'payload.after':
      return payload.after;
    case 'payload.diff':
      return payload.diff;
    case 'payload.record':
      return payload.after ?? payload.before;
    default:
      return token;
  }
}
