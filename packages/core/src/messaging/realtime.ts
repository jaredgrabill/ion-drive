/**
 * Realtime bridge — fans committed outbox events out to in-process subscribers
 * (the SSE stream at `GET /api/v1/events/stream`). Phase 12 / ADR-019.
 *
 * Deliberately NOT a dispatcher consumer group: a ledger-backed group would
 * treat the entire outbox history as undelivered for every new connection and
 * write a delivery row per event per connection. Instead the bridge keeps an
 * **ephemeral cursor**: it starts at connect time, polls `_ion_events` for
 * newer rows (nudged immediately by the bus's post-commit wake, so latency is
 * effectively the commit itself), and pushes matches to subscribers. A small
 * overlap window plus a seen-id ring absorbs commit-order skew (a slow
 * transaction committing an event whose `occurred_at` is already behind the
 * cursor). Semantics are best-effort from connect time — no replay, no
 * persistence — which is exactly what a realtime feed wants; consumers that
 * need guarantees use a subscription (consumer group) instead.
 *
 * The bridge only polls while at least one subscriber is connected.
 */

import type { EventRow, EventStore } from './event-store.js';
import type { IonEvent } from './event-types.js';
import { topicMatches } from './topic-match.js';

export interface RealtimeBridgeOptions {
  /** Fallback poll cadence (ms); a committed publish also wakes the bridge. */
  pollIntervalMs?: number;
  /** Max events read per poll. */
  batchSize?: number;
  /** Re-read window before the cursor absorbing commit-order skew (ms). */
  overlapMs?: number;
  /** Seen-id ring capacity (dedupe across the overlap window). */
  seenCapacity?: number;
}

/** A subscriber's push callback; errors are swallowed per event. */
export type RealtimeListener = (event: IonEvent) => void | Promise<void>;

interface Subscriber {
  topics: string[];
  listener: RealtimeListener;
}

export class RealtimeBridge {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly overlapMs: number;
  private readonly seenCapacity: number;

  private readonly subscribers = new Set<Subscriber>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private cursor: Date = new Date();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private runAgain = false;

  constructor(
    private readonly store: EventStore,
    options: RealtimeBridgeOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.batchSize = options.batchSize ?? 200;
    this.overlapMs = options.overlapMs ?? 5_000;
    this.seenCapacity = options.seenCapacity ?? 4096;
  }

  /** Number of live subscribers (exposed for tests/stats). */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Subscribes to events matching any of the topic patterns (the
   * `topic-match` grammar), starting from now. Returns the unsubscribe
   * function; the last unsubscribe stops polling entirely.
   */
  subscribe(topics: string[], listener: RealtimeListener): () => void {
    const subscriber: Subscriber = { topics, listener };
    if (this.subscribers.size === 0) this.startPolling();
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.stopPolling();
    };
  }

  /** Schedules a drain, coalescing overlapping requests (dispatcher pattern). */
  trigger(): void {
    if (this.subscribers.size === 0) return;
    if (this.running) {
      this.runAgain = true;
      return;
    }
    void this.drain();
  }

  /** Stops polling; subscribers stay registered (used on shutdown). */
  stop(): void {
    this.stopPolling();
  }

  private startPolling(): void {
    // A fresh listener set means a fresh horizon — never replay the backlog.
    this.cursor = new Date();
    this.timer = setInterval(() => this.trigger(), this.pollIntervalMs);
    // Long-running-but-idle servers shouldn't stay alive for the feed alone.
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      do {
        this.runAgain = false;
        const rows = await this.store.listSince({
          after: this.cursor,
          overlapMs: this.overlapMs,
          limit: this.batchSize,
        });
        for (const row of rows) {
          if (row.occurredAt > this.cursor) this.cursor = row.occurredAt;
          if (!this.markSeen(row.id)) continue;
          await this.broadcast(row);
        }
        // A full batch likely means more remain; loop again promptly.
        if (rows.length === this.batchSize) this.runAgain = true;
      } while (this.runAgain && this.subscribers.size > 0);
    } catch {
      // Best-effort: a failed poll is retried on the next tick/wake.
    } finally {
      this.running = false;
    }
  }

  /** Records an id in the dedupe ring; returns false when already seen. */
  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.seenCapacity) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
    return true;
  }

  private async broadcast(row: EventRow): Promise<void> {
    const event: IonEvent = {
      id: row.id,
      topic: row.topic,
      payload: row.payload,
      occurredAt: row.occurredAt,
    };
    for (const subscriber of this.subscribers) {
      if (!subscriber.topics.some((pattern) => topicMatches(pattern, event.topic))) continue;
      try {
        await subscriber.listener(event);
      } catch {
        // One slow/broken client must not break the fan-out.
      }
    }
  }
}
