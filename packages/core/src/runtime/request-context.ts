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
  /**
   * Explicit role binding of the current principal (API keys carry one; session
   * users resolve roles through `_ion_user_roles` instead). Consumed by the
   * row-policy resolver (issue #7), which needs the same inputs the permission
   * engine uses — without threading the full AuthPrincipal through DataService.
   */
  roleId: string | null;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/** The actor of the current request, or `null` outside any request/actor scope. */
export function currentActor(): ActorRef | null {
  return storage.getStore()?.actor ?? null;
}

/** The current principal's explicit role binding (API keys), or `null`. */
export function currentActorRoleId(): string | null {
  return storage.getStore()?.roleId ?? null;
}

/**
 * Whether the caller is inside an actor scope at all — true for anything
 * descending from a request (even an anonymous one) or a `runWithActor` call;
 * false for background code (dispatcher deliveries, scheduled tasks, boot).
 * Row policies (issue #7) apply only inside a scope: background/system code
 * keeps full access, while an in-request `null` actor means *anonymous*.
 */
export function hasActorScope(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * The single opaque identifier for the current actor — the user id when known,
 * else the API key id. This is what `created_by`/`updated_by` store.
 */
export function currentActorId(): string | null {
  const actor = currentActor();
  return actor ? (actor.userId ?? actor.apiKeyId) : null;
}

/**
 * Runs `fn` with `actor` as the ambient actor (embedders, tests, task
 * handlers). `options.roleId` carries an explicit role binding (API-key-style
 * principals) for row-policy resolution. Note that under RBAC enforcement a
 * `null` actor inside a scope is treated as *anonymous* — background code that
 * wants unrestricted DataService access should stay outside any scope instead.
 */
export function runWithActor<T>(
  actor: ActorRef | null,
  fn: () => T,
  options: { roleId?: string | null } = {},
): T {
  return storage.run({ actor, roleId: options.roleId ?? null }, fn);
}

/**
 * Opens a fresh (empty) context and runs `fn` inside it. This is the
 * @fastify/request-context pattern: a callback-style `onRequest` hook calls
 * the framework's `done` *inside* `fn`, which makes the rest of the request
 * pipeline (later hooks, the handler) descendants of this context. `enterWith`
 * would NOT work there — an async hook runs in a sibling frame, so the handler
 * never inherits it.
 */
export function runWithNewContext(fn: () => void): void {
  storage.run({ actor: null, roleId: null }, fn);
}

/**
 * Sets the actor (and optionally its explicit role binding) on the *current*
 * context (mutates the store `runWithNewContext` opened). No-op outside a
 * context — never throws.
 */
export function setCurrentActor(actor: ActorRef | null, roleId: string | null = null): void {
  const store = storage.getStore();
  if (store) {
    store.actor = actor;
    store.roleId = roleId;
  }
}
