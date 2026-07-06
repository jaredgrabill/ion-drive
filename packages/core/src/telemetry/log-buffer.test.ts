/**
 * Unit tests for the in-memory log buffer (Phase 8, Observability surface).
 *
 * Covers ring-buffer eviction, filtered queries (level/source/search/since,
 * pagination), live subscription, and the pino stream ingestion path.
 */

import { describe, expect, it } from 'vitest';
import { LogBuffer, type LogEntry, createLogBufferStream } from './log-buffer.js';

function entry(overrides: Partial<Omit<LogEntry, 'id'>> = {}): Omit<LogEntry, 'id'> {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'hello world',
    source: 'core',
    attributes: {},
    ...overrides,
  };
}

describe('LogBuffer', () => {
  it('stores entries and reports size', () => {
    const buffer = new LogBuffer(10);
    buffer.push(entry());
    buffer.push(entry({ level: 'error' }));
    expect(buffer.size).toBe(2);
  });

  it('evicts oldest entries beyond maxSize', () => {
    const buffer = new LogBuffer(3);
    for (let i = 0; i < 5; i++) buffer.push(entry({ message: `msg ${i}` }));
    expect(buffer.size).toBe(3);
    const { data } = buffer.query();
    // Newest first; the two oldest (msg 0, msg 1) were evicted.
    expect(data.map((e) => e.message)).toEqual(['msg 4', 'msg 3', 'msg 2']);
  });

  it('filters by level, source, and search', () => {
    const buffer = new LogBuffer(10);
    buffer.push(entry({ level: 'error', source: 'http', message: 'boom' }));
    buffer.push(entry({ level: 'info', source: 'core', message: 'fine' }));
    buffer.push(entry({ level: 'error', source: 'core', message: 'exploded badly' }));

    expect(buffer.query({ level: 'error' }).total).toBe(2);
    expect(buffer.query({ source: 'http' }).total).toBe(1);
    expect(buffer.query({ search: 'BOOM' }).total).toBe(1);
    expect(buffer.query({ level: 'error', source: 'core' }).total).toBe(1);
  });

  it('searches attribute values as well as the message', () => {
    const buffer = new LogBuffer(10);
    buffer.push(entry({ message: 'request', attributes: { path: '/api/v1/data/contacts' } }));
    expect(buffer.query({ search: 'contacts' }).total).toBe(1);
    expect(buffer.query({ search: 'nomatch' }).total).toBe(0);
  });

  it('supports since + pagination', () => {
    const buffer = new LogBuffer(10);
    buffer.push(entry({ timestamp: '2026-01-01T00:00:00.000Z', message: 'old' }));
    buffer.push(entry({ timestamp: '2026-06-01T00:00:00.000Z', message: 'new' }));
    expect(buffer.query({ since: '2026-03-01T00:00:00.000Z' }).data[0]?.message).toBe('new');

    for (let i = 0; i < 5; i++) buffer.push(entry({ message: `page ${i}` }));
    const page = buffer.query({ limit: 2, offset: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(7);
  });

  it('lists distinct sources and notifies subscribers', () => {
    const buffer = new LogBuffer(10);
    const seen: string[] = [];
    const unsubscribe = buffer.subscribe((e) => seen.push(e.message));
    buffer.push(entry({ source: 'http', message: 'a' }));
    buffer.push(entry({ source: 'core', message: 'b' }));
    unsubscribe();
    buffer.push(entry({ message: 'c' }));
    expect(seen).toEqual(['a', 'b']);
    expect(buffer.sources()).toEqual(['core', 'http']);
  });

  it('ingests pino JSON lines through the stream', async () => {
    const buffer = new LogBuffer(10);
    const stream = createLogBufferStream(buffer);
    const line = `${JSON.stringify({
      level: 50,
      time: 1750000000000,
      msg: 'database exploded',
      name: 'schema-manager',
      reqId: 'req-1',
      detail: 'boom',
    })}\n`;
    await new Promise<void>((resolve, reject) =>
      stream.write(line, (err) => (err ? reject(err) : resolve())),
    );
    expect(buffer.size).toBe(1);
    const [stored] = buffer.query().data;
    expect(stored?.level).toBe('error');
    expect(stored?.message).toBe('database exploded');
    expect(stored?.source).toBe('schema-manager');
    expect(stored?.attributes.detail).toBe('boom');
    // Reserved pino fields are not duplicated into attributes.
    expect(stored?.attributes.level).toBeUndefined();
    expect(stored?.attributes.msg).toBeUndefined();
  });

  it('ingests non-JSON lines as plain info entries', async () => {
    const buffer = new LogBuffer(10);
    const stream = createLogBufferStream(buffer);
    await new Promise<void>((resolve, reject) =>
      stream.write('raw text line\n', (err) => (err ? reject(err) : resolve())),
    );
    expect(buffer.query().data[0]?.message).toBe('raw text line');
    expect(buffer.query().data[0]?.level).toBe('info');
  });
});
