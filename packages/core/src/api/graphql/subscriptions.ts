/**
 * GraphQL subscriptions (Phase 13) — `Subscription.events(topics)` bridges the
 * Phase 12 RealtimeBridge into GraphQL's async-iterator protocol, served by
 * yoga's built-in GraphQL-over-SSE transport.
 *
 * Semantics are identical to `GET /api/v1/events/stream`: best-effort from
 * connect time (a feed, not a queue), topic patterns in the topic-match
 * grammar (default `data.#`), per-event RBAC via the shared event-access
 * filter (unauthorized events are skipped, not errors). The connection itself
 * requires authentication under enforcement — an anonymous subscriber would
 * see nothing anyway, so it fails loudly at subscribe time instead.
 *
 * Each subscription holds a small push queue between bridge callbacks and the
 * iterator's consumer; a slow client past {@link MAX_QUEUED_EVENTS} loses the
 * oldest events (best-effort, like the SSE socket's kernel buffer).
 */

import { GraphQLError, type GraphQLFieldResolver } from 'graphql';
import type { PermissionEngine } from '../../auth/rbac/permission-engine.js';
import type { AuthPrincipal } from '../../auth/types.js';
import { createEventAccessFilter } from '../../messaging/event-access.js';
import type { IonEvent } from '../../messaging/event-types.js';
import type { RealtimeBridge } from '../../messaging/realtime.js';

/** Queue bound per subscription; overflow drops the oldest event. */
const MAX_QUEUED_EVENTS = 1000;

export interface EventsSubscriptionDeps {
  realtime: RealtimeBridge;
  permissionEngine: PermissionEngine;
  /** When true, subscribing requires an authenticated principal. */
  enforce: boolean;
}

/** The GraphQL context shape the subscribe resolver reads its principal from. */
interface AuthCarryingContext {
  req?: { auth?: AuthPrincipal | null };
}

/**
 * Builds the `subscribe` resolver for `Subscription.events`. The returned
 * iterator pushes RBAC-filtered bridge events until the client disconnects
 * (yoga calls `return()` on the iterator, which unsubscribes).
 */
export function makeEventsSubscribe(
  deps: EventsSubscriptionDeps,
): GraphQLFieldResolver<unknown, unknown, { topics?: string[] | null }> {
  return (_source, args, context) => {
    const auth = (context as AuthCarryingContext | null)?.req?.auth ?? null;
    if (deps.enforce && !auth) {
      throw new GraphQLError('Authentication required to subscribe to events');
    }
    const topics = args.topics?.length ? args.topics : ['data.#'];
    const allowed = createEventAccessFilter({
      enforce: deps.enforce,
      permissionEngine: deps.permissionEngine,
      auth,
    });
    return createEventIterator(deps.realtime, topics, allowed);
  };
}

/**
 * Bridges RealtimeBridge's push callbacks into an async iterator: events land
 * in a bounded queue; `next()` drains it, awaiting a wake signal when empty.
 */
function createEventIterator(
  realtime: RealtimeBridge,
  topics: string[],
  allowed: (topic: string) => Promise<boolean>,
): AsyncIterableIterator<IonEvent> {
  const queue: IonEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const unsubscribe = realtime.subscribe(topics, async (event) => {
    if (finished || !(await allowed(event.topic))) return;
    queue.push(event);
    if (queue.length > MAX_QUEUED_EVENTS) queue.shift();
    wake?.();
  });

  const finish = () => {
    if (finished) return;
    finished = true;
    unsubscribe();
    wake?.();
  };

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<IonEvent>> {
      while (!finished) {
        const event = queue.shift();
        if (event) return { value: event, done: false };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      return { value: undefined, done: true };
    },
    async return(): Promise<IteratorResult<IonEvent>> {
      finish();
      return { value: undefined, done: true };
    },
    async throw(err: unknown): Promise<IteratorResult<IonEvent>> {
      finish();
      throw err;
    },
  };
}
