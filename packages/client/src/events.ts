/**
 * Realtime events (Phase 12) — a zero-dependency SSE consumer for
 * `GET /api/v1/events/stream`, built on the same global `fetch` the rest of
 * the SDK uses (works in Node 18+ and browsers; no EventSource needed, which
 * also means auth headers work).
 *
 *   const stream = ion.events.stream('data.contacts.*', (event) => {
 *     console.log(event.topic, event.payload);
 *   });
 *   // later:
 *   stream.close();
 *
 * Delivery is best-effort from connect time (the server does not replay
 * missed events). The consumer auto-reconnects with capped exponential
 * backoff until `close()` is called.
 */

/** The event envelope pushed by the server (occurredAt is ISO-8601). */
export interface IonEventMessage<T = unknown> {
  id: string;
  topic: string;
  payload: T;
  occurredAt: string;
}

export interface EventStreamOptions {
  /** Called when a connection attempt or read fails (before any retry). */
  onError?: (error: unknown) => void;
  /** Called each time the stream (re)connects. */
  onConnect?: () => void;
  /** Disable auto-reconnect (default: reconnects until closed). */
  reconnect?: boolean;
}

/** Handle for an open stream; `close()` stops reading and any reconnects. */
export interface EventStreamHandle {
  close(): void;
}

/** What the events API needs from the client (kept minimal for testability). */
export interface EventsTransport {
  baseUrl: string;
  fetchImpl: typeof fetch;
  headers: () => Record<string, string>;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class EventsApi {
  constructor(private readonly transport: EventsTransport) {}

  /**
   * Opens a realtime subscription for one or more topic patterns (e.g.
   * `data.contacts.*`, `data.#`). Events matching any pattern — and passing
   * the server's per-object RBAC filter — invoke `onEvent`.
   */
  stream<T = unknown>(
    topics: string | string[],
    onEvent: (event: IonEventMessage<T>) => void,
    options: EventStreamOptions = {},
  ): EventStreamHandle {
    const session: StreamSession = {
      topics: Array.isArray(topics) ? topics.join(',') : topics,
      controller: new AbortController(),
      closed: false,
      lastEventId: undefined,
    };

    const run = async () => {
      let backoff = INITIAL_BACKOFF_MS;
      while (!session.closed) {
        const connected = await this.attempt(session, onEvent, options);
        if (session.closed || options.reconnect === false) return;
        if (connected) backoff = INITIAL_BACKOFF_MS; // a healthy connection resets the clock
        await sleep(backoff, session.controller.signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    };
    void run();

    return {
      close: () => {
        session.closed = true;
        session.controller.abort();
      },
    };
  }

  /** One connect-and-read cycle; returns whether the connection was healthy. */
  private async attempt<T>(
    session: StreamSession,
    onEvent: (event: IonEventMessage<T>) => void,
    options: EventStreamOptions,
  ): Promise<boolean> {
    try {
      const url = `${this.transport.baseUrl}/api/v1/events/stream?topics=${encodeURIComponent(
        session.topics,
      )}`;
      const res = await this.transport.fetchImpl(url, {
        headers: {
          accept: 'text/event-stream',
          ...(session.lastEventId ? { 'last-event-id': session.lastEventId } : {}),
          ...this.transport.headers(),
        },
        signal: session.controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Event stream connection failed with status ${res.status}`);
      }
      options.onConnect?.();
      await this.consume<T>(res.body, onEvent, (id) => {
        session.lastEventId = id;
      });
      return true;
    } catch (err) {
      if (!session.closed) options.onError?.(err);
      return false;
    }
  }

  /** Reads and parses SSE frames until the stream ends. */
  private async consume<T>(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: IonEventMessage<T>) => void,
    trackId: (id: string) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line; keep the trailing partial frame.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        dispatchFrame(frame, onEvent, trackId);
      }
    }
  }
}

/** Internal per-stream state shared by the reconnect loop and close(). */
interface StreamSession {
  topics: string;
  controller: AbortController;
  closed: boolean;
  lastEventId: string | undefined;
}

/** Parses one frame and invokes the callbacks (heartbeats are skipped). */
function dispatchFrame<T>(
  frame: string,
  onEvent: (event: IonEventMessage<T>) => void,
  trackId: (id: string) => void,
): void {
  const parsed = parseSseFrame(frame);
  if (parsed.id) trackId(parsed.id);
  if (parsed.data === undefined) return; // comment/heartbeat frame
  try {
    onEvent(JSON.parse(parsed.data) as IonEventMessage<T>);
  } catch {
    // Malformed frame — skip rather than kill the stream.
  }
}

/** Parses one SSE frame's `field: value` lines (data lines join with \n). */
function parseSseFrame(frame: string): { id?: string; event?: string; data?: string } {
  const result: { id?: string; event?: string; data?: string } = {};
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // comment (heartbeat)
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') result.id = value;
    else if (field === 'event') result.event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length > 0) result.data = dataLines.join('\n');
  return result;
}

/** Abortable sleep — an abort resolves immediately (the loop re-checks `closed`). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
