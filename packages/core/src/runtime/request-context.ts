/**
 * Ambient request context — who is acting, threaded without parameters.
 *
 * Phase 12 (ADR-019): every write should know its actor, but the actor would
 * otherwise have to be threaded as a parameter through every surface (REST
 * handlers, GraphQL resolvers, the per-request MCP server, the block
 * installer) down into `DataService`/`SchemaManager`. Instead the session
 * middleware stores the resolved {@link ActorRef} in an `AsyncLocalStorage`
 * once per request; anything running inside that request's async chain reads
 * it via {@link currentActor}. Code running *outside* a request — dispatcher
 * deliveries, scheduled tasks — correctly resolves to `null` (no actor).
 *
 * Programmatic embedders and tests can scope an actor explicitly with
 * {@link runWithActor}.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The identity attached to writes and change events. */
export interface ActorRef {
  /** User id (session logins, and API keys bound to a user). */
  userId: string | null;
  /** API key id when the caller authenticated with one. */
  apiKeyId: string | null;
  via: 'session' | 'api_key';
}

interface RequestContextStore {
  actor: ActorRef | null;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/** The actor of the current request, or `null` outside any request/actor scope. */
export function currentActor(): ActorRef | null {
  return storage.getStore()?.actor ?? null;
}

/**
 * The single opaque identifier for the current actor — the user id when known,
 * else the API key id. This is what `created_by`/`updated_by` store.
 */
export function currentActorId(): string | null {
  const actor = currentActor();
  return actor ? (actor.userId ?? actor.apiKeyId) : null;
}

/** Runs `fn` with `actor` as the ambient actor (embedders, tests, task handlers). */
export function runWithActor<T>(actor: ActorRef | null, fn: () => T): T {
  return storage.run({ actor }, fn);
}

/**
 * Binds the actor to the *current* async execution context and its descendants
 * (the `enterWith` pattern used by @fastify/request-context). Called by the
 * session middleware once per request, after `request.auth` is resolved.
 */
export function enterRequestContext(actor: ActorRef | null): void {
  storage.enterWith({ actor });
}
