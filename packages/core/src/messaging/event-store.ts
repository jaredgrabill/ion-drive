/**
 * Event persistence — the transactional outbox and its delivery ledger.
 *
 * Two tenant-database tables back the default bus (they live with the data
 * tables so an event insert is atomic with the CRUD write; see ADR-015):
 *  - `_ion_events` — the append-only outbox (id, topic, payload, occurred_at).
 *  - `_ion_event_deliveries` — one row per `(event, consumer_group)`, tracking
 *    at-most-once delivery to each consumer. The composite primary key is the
 *    arbiter: only one instance can insert the claim row for a given pair.
 *
 * {@link EventStore.claim} is the concurrency primitive — an upsert that also
 * reclaims failed (under a retry budget) and lease-expired in-flight rows, so
 * delivery is at-least-once and safe across multiple app instances without a
 * broker. Handlers must be idempotent on `event.id`.
 */

import { type Kysely, sql } from 'kysely';
import type { TenantDatabase } from '../db/types.js';
import type { BusTransaction, IonEvent } from './event-types.js';

/** A candidate event row surfaced to the dispatcher. */
export interface EventRow {
  id: string;
  topic: string;
  payload: unknown;
  occurredAt: Date;
}

/** Options for {@link EventStore.findCandidates}. */
export interface CandidateQuery {
  consumer: string;
  /** Coarse SQL `LIKE` prefix (exact matching is done in JS). */
  topicPrefix: string;
  batch: number;
  maxAttempts: number;
  /** In-flight lease (ms): a `pending` claim older than this is reclaimable. */
  leaseMs: number;
}

/** Creates the outbox and delivery tables if absent. Safe to call repeatedly. */
export async function bootstrapEventTables(db: Kysely<TenantDatabase>): Promise<void> {
  await db.schema
    .createTable('_ion_events')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('topic', 'varchar(255)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo('{}'))
    .addColumn('occurred_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  await db.schema
    .createIndex('_ion_events_topic_occurred_idx')
    .ifNotExists()
    .on('_ion_events')
    .columns(['topic', 'occurred_at'])
    .execute();

  await db.schema
    .createTable('_ion_event_deliveries')
    .ifNotExists()
    .addColumn('event_id', 'uuid', (col) =>
      col.notNull().references('_ion_events.id').onDelete('cascade'),
    )
    .addColumn('consumer_group', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('error', 'text')
    .addColumn('claimed_at', 'timestamptz')
    .addColumn('processed_at', 'timestamptz')
    .addPrimaryKeyConstraint('_ion_event_deliveries_pkey', ['event_id', 'consumer_group'])
    .execute();

  await db.schema
    .createIndex('_ion_event_deliveries_status_idx')
    .ifNotExists()
    .on('_ion_event_deliveries')
    .columns(['consumer_group', 'status'])
    .execute();
}

export class EventStore {
  constructor(private readonly db: Kysely<TenantDatabase>) {}

  /**
   * Inserts an event into the outbox. When `executor` is a transaction, the
   * insert joins that transaction (atomic with the caller's write).
   */
  async insert(event: IonEvent, executor: BusTransaction = this.db): Promise<void> {
    await executor
      .insertInto('_ion_events')
      .values({
        id: event.id,
        topic: event.topic,
        payload: JSON.stringify(event.payload),
        occurred_at: event.occurredAt,
      })
      .execute();
  }

  /**
   * Returns events matching the consumer's coarse topic prefix that are not yet
   * delivered to it — i.e. never attempted, failed under the retry budget, or a
   * lease-expired in-flight claim. Exact pattern matching happens in the caller.
   */
  async findCandidates(query: CandidateQuery): Promise<EventRow[]> {
    const result = await sql<EventRow>`
      select e.id, e.topic, e.payload, e.occurred_at as "occurredAt"
      from _ion_events e
      left join _ion_event_deliveries d
        on d.event_id = e.id and d.consumer_group = ${query.consumer}
      where e.topic like ${query.topicPrefix}
        and (
          d.event_id is null
          or (d.status = 'failed' and d.attempts < ${query.maxAttempts})
          or (d.status = 'pending'
              and d.claimed_at < now() - make_interval(secs => ${query.leaseMs} / 1000.0))
        )
      order by e.occurred_at asc
      limit ${query.batch}
    `.execute(this.db);
    return result.rows;
  }

  /**
   * Attempts to claim `(eventId, consumer)` for processing. Returns `true` iff
   * this caller won the claim — an unclaimed pair is inserted, and an existing
   * failed/lease-expired pair is atomically taken over. The composite PK makes
   * concurrent claims mutually exclusive.
   */
  async claim(
    eventId: string,
    consumer: string,
    maxAttempts: number,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await sql<{ event_id: string }>`
      insert into _ion_event_deliveries as d (event_id, consumer_group, status, attempts, claimed_at)
      values (${eventId}, ${consumer}, 'pending', 1, now())
      on conflict (event_id, consumer_group) do update
        set status = 'pending', attempts = d.attempts + 1, claimed_at = now()
        where (d.status = 'failed' and d.attempts < ${maxAttempts})
           or (d.status = 'pending'
               and d.claimed_at < now() - make_interval(secs => ${leaseMs} / 1000.0))
      returning event_id
    `.execute(this.db);
    return result.rows.length > 0;
  }

  /** Marks a claimed delivery successful. */
  async markDone(eventId: string, consumer: string): Promise<void> {
    await this.db
      .updateTable('_ion_event_deliveries')
      .set({ status: 'done', processed_at: sql`now()`, error: null })
      .where('event_id', '=', eventId)
      .where('consumer_group', '=', consumer)
      .execute();
  }

  /** Marks a claimed delivery failed, recording the error for inspection/retry. */
  async markFailed(eventId: string, consumer: string, error: string): Promise<void> {
    await this.db
      .updateTable('_ion_event_deliveries')
      .set({ status: 'failed', error })
      .where('event_id', '=', eventId)
      .where('consumer_group', '=', consumer)
      .execute();
  }
}
