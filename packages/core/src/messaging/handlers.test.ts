import { describe, expect, it } from 'vitest';
import type { LoggerProvider } from '../logging/logger-provider.js';
import type { EventContext, IonEvent, Subscription } from './event-types.js';
import { type RecordWriter, createPersistEventHandler, logEventHandler } from './handlers.js';

const silentLogger: LoggerProvider = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

function makeContext(event: IonEvent, subscription: Subscription): EventContext {
  return { event, subscription, signal: new AbortController().signal, logger: silentLogger };
}

const updateEvent: IonEvent = {
  id: 'evt_1',
  topic: 'data.contacts.updated',
  occurredAt: new Date('2026-07-05T00:00:00Z'),
  payload: {
    object: 'contacts',
    id: 'rec_1',
    op: 'updated',
    before: { name: 'Ann' },
    after: { name: 'Anne' },
    diff: { name: { before: 'Ann', after: 'Anne' } },
  },
};

describe('persist_event handler', () => {
  it('maps event/payload tokens onto columns and writes a row', async () => {
    const writes: { object: string; data: Record<string, unknown> }[] = [];
    const writer: RecordWriter = {
      insert: async (object, data) => void writes.push({ object, data }),
    };
    const handler = createPersistEventHandler(writer);

    const subscription: Subscription = {
      topic: 'data.#',
      consumer: 'audit',
      handler: 'persist_event',
      config: {
        object: 'audit_log',
        map: {
          object_name: 'payload.object',
          record_id: 'payload.id',
          operation: 'payload.op',
          diff: 'payload.diff',
          snapshot: 'payload.record',
          event_id: 'event.id',
        },
      },
    };

    await handler.handle(makeContext(updateEvent, subscription));

    expect(writes).toHaveLength(1);
    expect(writes[0]?.object).toBe('audit_log');
    expect(writes[0]?.data).toEqual({
      object_name: 'contacts',
      record_id: 'rec_1',
      operation: 'updated',
      diff: { name: { before: 'Ann', after: 'Anne' } },
      snapshot: { name: 'Anne' },
      event_id: 'evt_1',
    });
  });

  it('falls back to the before-image for payload.record on deletes', async () => {
    const writes: Record<string, unknown>[] = [];
    const writer: RecordWriter = { insert: async (_o, data) => void writes.push(data) };
    const handler = createPersistEventHandler(writer);
    const deleteEvent: IonEvent = {
      id: 'evt_2',
      topic: 'data.contacts.deleted',
      occurredAt: new Date(),
      payload: {
        object: 'contacts',
        id: 'rec_1',
        op: 'deleted',
        before: { name: 'Ann' },
        after: null,
      },
    };

    await handler.handle(
      makeContext(deleteEvent, {
        topic: 'data.#',
        consumer: 'audit',
        handler: 'persist_event',
        config: { object: 'audit_log', map: { snapshot: 'payload.record' } },
      }),
    );

    expect(writes[0]?.snapshot).toEqual({ name: 'Ann' });
  });

  it('throws when config.object is missing', async () => {
    const handler = createPersistEventHandler({ insert: async () => {} });
    await expect(
      handler.handle(
        makeContext(updateEvent, { topic: '#', consumer: 'x', handler: 'persist_event' }),
      ),
    ).rejects.toThrow(/object/);
  });
});

describe('log_event handler', () => {
  it('logs the event topic without throwing', async () => {
    const infos: string[] = [];
    const logger: LoggerProvider = { ...silentLogger, info: (m) => infos.push(m) };
    await logEventHandler.handle({
      event: updateEvent,
      subscription: { topic: '#', consumer: 'x', handler: 'log_event' },
      signal: new AbortController().signal,
      logger,
    });
    expect(infos[0]).toContain('data.contacts.updated');
  });
});
