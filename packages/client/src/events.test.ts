/**
 * Phase 12: the SDK's SSE consumer — frame parsing, header propagation,
 * reconnect behaviour, and clean close.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventsApi, type IonEventMessage } from './events.js';

const encoder = new TextEncoder();

/** Builds an SSE Response from raw frame text chunks. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function frame(event: IonEventMessage): string {
  return `id: ${event.id}\nevent: ${event.topic}\ndata: ${JSON.stringify(event)}\n\n`;
}

const e1: IonEventMessage = {
  id: 'e1',
  topic: 'data.contacts.created',
  payload: { object: 'contacts', id: 'r1' },
  occurredAt: '2026-07-06T00:00:00.000Z',
};
const e2: IonEventMessage = { ...e1, id: 'e2', topic: 'data.contacts.updated' };

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('EventsApi.stream', () => {
  it('parses frames (skipping heartbeats) and delivers events with auth headers', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['retry: 3000\n\n', frame(e1), ': heartbeat\n\n', frame(e2)]),
    );
    const api = new EventsApi({
      baseUrl: 'http://x.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: () => ({ 'x-api-key': 'iond_k' }),
    });

    const seen: IonEventMessage[] = [];
    const handle = api.stream(['data.contacts.*'], (e) => void seen.push(e), {
      reconnect: false,
    });
    await waitFor(() => seen.length === 2);
    handle.close();

    expect(seen.map((e) => e.id)).toEqual(['e1', 'e2']);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://x.test/api/v1/events/stream?topics=data.contacts.*');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('iond_k');
    expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
  });

  it('handles frames split across chunks', async () => {
    const text = frame(e1);
    const fetchImpl = vi.fn(async () => sseResponse([text.slice(0, 10), text.slice(10)]));
    const api = new EventsApi({
      baseUrl: 'http://x.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: () => ({}),
    });

    const seen: IonEventMessage[] = [];
    const handle = api.stream('data.#', (e) => void seen.push(e), { reconnect: false });
    await waitFor(() => seen.length === 1);
    handle.close();
    expect(seen[0]?.payload).toEqual({ object: 'contacts', id: 'r1' });
  });

  it('reconnects after the stream ends, sending last-event-id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sseResponse([frame(e1)]))
      .mockResolvedValueOnce(sseResponse([frame(e2)]))
      .mockResolvedValue(sseResponse([]));
    const api = new EventsApi({
      baseUrl: 'http://x.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: () => ({}),
    });

    const seen: string[] = [];
    const handle = api.stream('data.#', (e) => void seen.push(e.id));
    await waitFor(() => seen.length === 2, 5000);
    handle.close();

    const secondInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect((secondInit.headers as Record<string, string>)['last-event-id']).toBe('e1');
  });

  it('close() stops the loop — no further fetches', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([frame(e1)]));
    const api = new EventsApi({
      baseUrl: 'http://x.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: () => ({}),
    });
    const seen: string[] = [];
    const handle = api.stream('data.#', (e) => void seen.push(e.id));
    await waitFor(() => seen.length === 1);
    handle.close();
    const calls = fetchImpl.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it('reports connection errors through onError', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const api = new EventsApi({
      baseUrl: 'http://x.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: () => ({}),
    });
    const errors: unknown[] = [];
    const handle = api.stream('data.#', () => {}, {
      reconnect: false,
      onError: (err) => void errors.push(err),
    });
    await waitFor(() => errors.length === 1);
    handle.close();
    expect(String(errors[0])).toContain('401');
  });
});
