/**
 * Event dispatcher — drains the outbox to subscribers.
 *
 * The dispatcher periodically (and immediately on {@link OutboxBus.wake}) scans
 * `_ion_events` for events each subscription's consumer group has not yet
 * processed, atomically claims each `(event, group)` pair via the store, and
 * runs the subscription's handler under an abort/timeout — mirroring the task
 * runner's execution model. Claiming is what makes delivery **at-most-once per
 * consumer group across instances**; a `perInstance` subscription forms a group
 * per instance, giving once-per-instance delivery instead. Handlers must be
 * idempotent on `event.id` since a crash mid-processing leads to redelivery.
 * Each delivery emits an OpenTelemetry span and the `ion.event.*` metrics
 * (delivery counter + duration histogram), mirroring the task runner.
 * See ADR-015.
 */

import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { LoggerProvider } from '../logging/logger-provider.js';
import { recordEventDelivery } from '../telemetry/metrics.js';
import { ION_ATTR } from '../telemetry/span-attributes.js';
import type { EventRow, EventStore } from './event-store.js';
import type { IonEvent, Subscription } from './event-types.js';
import type { OutboxBus } from './outbox-bus.js';
import { topicLikePrefix, topicMatches } from './topic-match.js';

const TRACER_NAME = '@ionshift/ion-drive-core';

export interface EventDispatcherOptions {
  logger: LoggerProvider;
  /** Fallback poll cadence (ms); a commit also wakes the dispatcher. */
  pollIntervalMs?: number;
  /** Max events claimed per subscription per tick. */
  batchSize?: number;
  /** Retry budget for a failed delivery. */
  maxAttempts?: number;
  /** In-flight lease (ms) after which a stuck `pending` claim is reclaimable. */
  leaseMs?: number;
  /** Per-delivery handler timeout (ms). */
  handlerTimeoutMs?: number;
  /** Stable per-instance id for `perInstance` consumer groups. */
  instanceId?: string;
}

export class EventDispatcher {
  private readonly logger: LoggerProvider;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly handlerTimeoutMs: number;
  private readonly instanceId: string;

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private runAgain = false;
  private started = false;

  constructor(
    private readonly store: EventStore,
    private readonly bus: OutboxBus,
    options: EventDispatcherOptions,
  ) {
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 30_000;
    this.instanceId = options.instanceId ?? randomUUID();
  }

  /** Begins polling and wires the bus's wake signal to an immediate drain. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.bus.setWakeHandler(() => this.trigger());
    this.timer = setInterval(() => this.trigger(), this.pollIntervalMs);
    this.trigger();
  }

  /** Stops polling. In-flight deliveries are allowed to finish. */
  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Schedules a drain, coalescing overlapping requests into a single run. */
  trigger(): void {
    if (this.running) {
      this.runAgain = true;
      return;
    }
    void this.runPending();
  }

  /**
   * Drains the outbox to completion and resolves when idle. `trigger()` is the
   * fire-and-forget variant used by the poll timer and wake signal; tests and
   * callers that need to await delivery use this directly.
   */
  async runPending(): Promise<void> {
    this.running = true;
    try {
      do {
        this.runAgain = false;
        let more = false;
        for (const subscription of this.bus.listSubscriptions()) {
          more = (await this.drainSubscription(subscription)) || more;
        }
        // A full batch likely means more remain; loop again promptly.
        if (more) this.runAgain = true;
      } while (this.runAgain && this.started);
    } finally {
      this.running = false;
    }
  }

  /**
   * Processes one batch for a subscription. Returns whether a full batch was
   * claimed (a hint that more events may remain).
   */
  private async drainSubscription(subscription: Subscription): Promise<boolean> {
    const consumer = this.effectiveGroup(subscription);
    let candidates: EventRow[];
    try {
      candidates = await this.store.findCandidates({
        consumer,
        topicPrefix: topicLikePrefix(subscription.topic),
        batch: this.batchSize,
        maxAttempts: this.maxAttempts,
        leaseMs: this.leaseMs,
      });
    } catch (err) {
      this.logger.error('Event dispatcher failed to query candidates', {
        consumer,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    let claimedCount = 0;
    for (const row of candidates) {
      if (!topicMatches(subscription.topic, row.topic)) continue;
      const claimed = await this.store.claim(row.id, consumer, this.maxAttempts, this.leaseMs);
      if (!claimed) continue;
      claimedCount += 1;
      await this.deliver(subscription, consumer, row);
    }

    return candidates.length === this.batchSize && claimedCount > 0;
  }

  /** Runs the subscription's handler for one claimed event. */
  private async deliver(
    subscription: Subscription,
    consumer: string,
    row: EventRow,
  ): Promise<void> {
    const handler = this.bus.getHandler(subscription.handler);
    const event: IonEvent = {
      id: row.id,
      topic: row.topic,
      payload: row.payload,
      occurredAt: row.occurredAt,
    };

    const metricAttributes = {
      [ION_ATTR.EVENT_TOPIC]: row.topic,
      [ION_ATTR.EVENT_CONSUMER]: consumer,
      [ION_ATTR.EVENT_HANDLER]: subscription.handler,
    };

    if (!handler) {
      const message = `No handler "${subscription.handler}" registered for consumer "${subscription.consumer}"`;
      this.logger.warn(message, { topic: row.topic });
      await this.store.markFailed(row.id, consumer, message);
      recordEventDelivery(0, { ...metricAttributes, [ION_ATTR.OUTCOME]: 'failed' });
      return;
    }

    const span = trace.getTracer(TRACER_NAME).startSpan(`event ${row.topic}`, {
      attributes: metricAttributes,
    });
    const startNs = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'success';
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Event handler timed out')),
      this.handlerTimeoutMs,
    );

    try {
      await this.race(
        handler.handle({ event, subscription, signal: controller.signal, logger: this.logger }),
        controller.signal,
      );
      await this.store.markDone(row.id, consumer);
    } catch (err) {
      outcome = 'failed';
      const message = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      this.logger.error(`Event handler "${subscription.handler}" failed`, {
        topic: row.topic,
        consumer,
        error: message,
      });
      await this.store.markFailed(row.id, consumer, message);
    } finally {
      clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      span.setAttribute(ION_ATTR.OUTCOME, outcome);
      span.end();
      recordEventDelivery(durationMs, { ...metricAttributes, [ION_ATTR.OUTCOME]: outcome });
    }
  }

  /** The delivery group for a subscription (per-instance suffix when requested). */
  private effectiveGroup(subscription: Subscription): string {
    return subscription.perInstance
      ? `${subscription.consumer}::${this.instanceId}`
      : subscription.consumer;
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
