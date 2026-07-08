/**
 * RedisDispatcher — drains the Redis event stream to subscribers, mirroring
 * core's outbox EventDispatcher contract:
 *
 *  - **once per consumer group across instances** — each Ion consumer group is
 *    a Redis consumer group on the shared stream; XREADGROUP/XCLAIM arbitrate
 *    which instance handles an entry. `perInstance` subscriptions get a
 *    `<consumer>::<instanceId>` group each (destroyed on stop — they are
 *    meaningless once the instance is gone).
 *  - **retry with exponential backoff** — a failed delivery stays in the
 *    group's pending list (no XACK); a retry pass XCLAIMs entries whose idle
 *    time exceeds `baseMs × 2^(deliveries-1)` (capped), so redeliveries pace
 *    exactly like the outbox's `next_attempt_at` schedule. XCLAIM's min-idle
 *    guard doubles as the cross-instance race arbiter.
 *  - **DLQ after the retry budget** — an entry delivered `maxAttempts` times
 *    is acknowledged and copied to the `<prefix>events:dlq` stream with its
 *    consumer/handler/error context (the outbox equivalent is the
 *    `failed`-status delivery row).
 *  - **telemetry parity** — every delivery emits an `event <topic>` span and
 *    the `ion.event.deliveries`/`ion.event.delivery.duration` metrics via
 *    core's exported helpers, so dashboards don't care which bus runs.
 *
 * Entries whose topic doesn't match a group's pattern are acknowledged
 * immediately: with a broker every group sees every entry, so a non-match is
 * "processed" from that group's point of view (the outbox reaches the same
 * outcome by never claiming the row).
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF,
  ION_ATTR,
  type IonEvent,
  type LoggerProvider,
  type RetryBackoff,
  type Subscription,
  recordEventDelivery,
  topicMatches,
} from '@ion-drive/core';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { RedisApi, StreamEntry } from './redis-api.js';
import { type RedisStreamsBus, eventFromFields } from './streams-bus.js';

const TRACER_NAME = '@ion-drive/plugin-redis';

export interface RedisDispatcherOptions {
  logger: LoggerProvider;
  /** Fallback poll cadence (ms); a publish also wakes the dispatcher. */
  pollIntervalMs?: number;
  /** Max entries read per group per tick. */
  batchSize?: number;
  /** Retry budget for a failed delivery (then DLQ). */
  maxAttempts?: number;
  /** Per-delivery handler timeout (ms). */
  handlerTimeoutMs?: number;
  /** Exponential backoff between retries of a failed delivery. */
  retryBackoff?: RetryBackoff;
  /** Stable per-instance id for `perInstance` consumer groups. */
  instanceId?: string;
  /** Approximate MAXLEN for the dead-letter stream. */
  dlqMaxLen?: number;
}

export class RedisDispatcher {
  private readonly logger: LoggerProvider;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly handlerTimeoutMs: number;
  private readonly retryBackoff: RetryBackoff;
  private readonly instanceId: string;
  private readonly dlqMaxLen: number;

  private readonly knownGroups = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private runAgain = false;
  private started = false;

  constructor(
    private readonly redis: RedisApi,
    private readonly bus: RedisStreamsBus,
    options: RedisDispatcherOptions,
  ) {
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 30_000;
    this.retryBackoff = options.retryBackoff ?? DEFAULT_RETRY_BACKOFF;
    this.instanceId = options.instanceId ?? randomUUID();
    this.dlqMaxLen = options.dlqMaxLen ?? 10_000;
  }

  /** Begins polling and wires the bus's wake signal to an immediate drain. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.bus.setWakeHandler(() => this.trigger());
    this.timer = setInterval(() => this.trigger(), this.pollIntervalMs);
    this.trigger();
  }

  /** Stops polling and destroys this instance's per-instance groups. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const subscription of this.bus.listSubscriptions()) {
      if (!subscription.perInstance) continue;
      await this.redis.destroyGroup(this.bus.streamKey, this.effectiveGroup(subscription));
    }
  }

  /** Schedules a drain, coalescing overlapping requests into a single run. */
  trigger(): void {
    if (this.running) {
      this.runAgain = true;
      return;
    }
    void this.runPending().catch((err) => {
      this.logger.error('Redis dispatcher drain failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Drains all groups to completion; tests await this directly. */
  async runPending(): Promise<void> {
    this.running = true;
    try {
      do {
        this.runAgain = false;
        let more = false;
        for (const subscription of this.bus.listSubscriptions()) {
          more = (await this.drainSubscription(subscription)) || more;
        }
        if (more) this.runAgain = true;
      } while (this.runAgain && this.started);
    } finally {
      this.running = false;
    }
  }

  /** One tick for one subscription: new entries, then due retries. */
  private async drainSubscription(subscription: Subscription): Promise<boolean> {
    const group = this.effectiveGroup(subscription);
    try {
      if (!this.knownGroups.has(group)) {
        await this.redis.ensureGroup(this.bus.streamKey, group);
        this.knownGroups.add(group);
      }
      const fresh = await this.deliverNew(subscription, group);
      await this.retryPending(subscription, group);
      return fresh === this.batchSize;
    } catch (err) {
      this.logger.error('Redis dispatcher failed to drain group', {
        group,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Reads never-delivered entries; returns how many were read. */
  private async deliverNew(subscription: Subscription, group: string): Promise<number> {
    const entries = await this.redis.readGroup(
      this.bus.streamKey,
      group,
      this.instanceId,
      this.batchSize,
    );
    for (const entry of entries) {
      await this.processEntry(subscription, group, entry, 1);
    }
    return entries.length;
  }

  /** Claims and re-delivers failed entries whose backoff has elapsed. */
  private async retryPending(subscription: Subscription, group: string): Promise<void> {
    const pending = await this.redis.pending(this.bus.streamKey, group, this.batchSize);
    for (const item of pending) {
      // Entries currently leased by a live consumer show a small idle time and
      // fall through the min-idle guard below, so no explicit lease tracking
      // is needed. `deliveries` counts the attempts already made.
      if (item.deliveries >= this.maxAttempts) {
        await this.deadLetter(subscription, group, item.id, item.deliveries);
        continue;
      }
      const requiredIdle = this.backoffFor(item.deliveries);
      if (item.idleMs < requiredIdle) continue;
      const claimed = await this.redis.claim(
        this.bus.streamKey,
        group,
        this.instanceId,
        requiredIdle,
        [item.id],
      );
      for (const entry of claimed) {
        await this.processEntry(subscription, group, entry, item.deliveries + 1);
      }
    }
  }

  /** Parses, topic-filters, and delivers one entry, acking when settled. */
  private async processEntry(
    subscription: Subscription,
    group: string,
    entry: StreamEntry,
    attempt: number,
  ): Promise<void> {
    const event = eventFromFields(entry.fields);
    if (!event) {
      // Unparseable entry — poison for every consumer; ack so it never loops.
      this.logger.warn('Skipping malformed event stream entry', { entryId: entry.id, group });
      await this.redis.ack(this.bus.streamKey, group, entry.id);
      return;
    }
    if (!topicMatches(subscription.topic, event.topic)) {
      await this.redis.ack(this.bus.streamKey, group, entry.id);
      return;
    }
    const ok = await this.deliver(subscription, group, event, attempt);
    if (ok) {
      await this.redis.ack(this.bus.streamKey, group, entry.id);
    } else if (attempt >= this.maxAttempts) {
      await this.deadLetter(subscription, group, entry.id, attempt);
    }
    // Otherwise: leave it pending — the retry pass picks it up after backoff.
  }

  /** Runs the handler under abort/timeout with span + metric parity. */
  private async deliver(
    subscription: Subscription,
    group: string,
    event: IonEvent<unknown>,
    attempt: number,
  ): Promise<boolean> {
    const metricAttributes = {
      [ION_ATTR.EVENT_TOPIC]: event.topic,
      [ION_ATTR.EVENT_CONSUMER]: group,
      [ION_ATTR.EVENT_HANDLER]: subscription.handler,
    };

    const handler = this.bus.getHandler(subscription.handler);
    if (!handler) {
      this.logger.warn(
        `No handler "${subscription.handler}" registered for consumer "${subscription.consumer}"`,
        { topic: event.topic, attempt },
      );
      recordEventDelivery(0, { ...metricAttributes, [ION_ATTR.OUTCOME]: 'failed' });
      return false;
    }

    const span = trace
      .getTracer(TRACER_NAME)
      .startSpan(`event ${event.topic}`, { attributes: metricAttributes });
    const startNs = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'success';
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Event handler timed out')),
      this.handlerTimeoutMs,
    );

    try {
      await this.race(
        handler.handle({
          event,
          subscription,
          signal: controller.signal,
          logger: this.logger,
        }),
        controller.signal,
      );
      return true;
    } catch (err) {
      outcome = 'failed';
      const message = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      this.logger.error(`Event handler "${subscription.handler}" failed`, {
        topic: event.topic,
        consumer: group,
        attempt,
        error: message,
      });
      return false;
    } finally {
      clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      span.setAttribute(ION_ATTR.OUTCOME, outcome);
      span.end();
      recordEventDelivery(durationMs, { ...metricAttributes, [ION_ATTR.OUTCOME]: outcome });
    }
  }

  /** Acks an exhausted entry and records it on the dead-letter stream. */
  private async deadLetter(
    subscription: Subscription,
    group: string,
    entryId: string,
    deliveries: number,
  ): Promise<void> {
    // Re-read the entry via claim (min-idle 0 also transfers ownership to us,
    // which is fine — we ack it immediately after copying).
    const claimed = await this.redis.claim(this.bus.streamKey, group, this.instanceId, 0, [
      entryId,
    ]);
    const entry = claimed[0];
    if (entry) {
      await this.redis.addToStream(
        this.bus.dlqKey,
        {
          ...entry.fields,
          consumer: group,
          handler: subscription.handler,
          deliveries: String(deliveries),
          deadLetteredAt: new Date().toISOString(),
        },
        this.dlqMaxLen,
      );
    }
    await this.redis.ack(this.bus.streamKey, group, entryId);
    this.logger.error('Event delivery exhausted its retry budget — dead-lettered', {
      entryId,
      consumer: group,
      handler: subscription.handler,
      deliveries,
    });
  }

  /** The delivery group for a subscription (per-instance suffix when requested). */
  private effectiveGroup(subscription: Subscription): string {
    return subscription.perInstance
      ? `${subscription.consumer}::${this.instanceId}`
      : subscription.consumer;
  }

  /** Retry delay before attempt `deliveries + 1`, mirroring the outbox schedule. */
  private backoffFor(deliveries: number): number {
    const exponent = Math.max(0, deliveries - 1);
    return Math.min(this.retryBackoff.baseMs * 2 ** exponent, this.retryBackoff.capMs);
  }

  /** Races a handler promise against its abort/timeout. */
  private async race<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('Event handler aborted'));
        signal.addEventListener('abort', () => reject(new Error('Event handler timed out')), {
          once: true,
        });
      }),
    ]);
  }
}
