/**
 * Row-level policies (issue #7 / Phase 17 / roadmap F12) — owner-scoped access.
 *
 * A {@link RowPolicy} rides on a permission grant (`{ resource, actions,
 * rowPolicy? }`), so the existing role machinery — admin UI, role validation,
 * public-role rails, block-installed roles — carries row scoping with zero new
 * storage. The language is deliberately tiny and non-Turing: `'all'`, `'own'`
 * (`created_by = actor`), `'none'`, and a field match (`equals`/`contains`
 * against `actor.id`). Policies are **app-layer**, enforced in `DataService`
 * as WHERE fragments and write guards: ADR-017's "anything Postgres can
 * enforce lives in Postgres" rule is deliberately not applied here because
 * policies are runtime-defined per role — native Postgres RLS would require
 * per-role database users and session GUC plumbing that the single-pool
 * tenant model doesn't have (see ADR-025).
 *
 * Resolution model (mirrors the permission engine's union semantics):
 *
 *   1. Collect every grant that allows the (action, object) pair — the
 *      principal's effective roles plus, for reads, the public role.
 *   2. Union their row policies. Any allowing grant without a `rowPolicy`
 *      (or with `'all'`) is unrestricted — this is both the compat default
 *      and the bypass: the admin role's `{ resource: '*', actions:
 *      ['manage'] }` grant carries no policy, so admins and admin-bound
 *      service keys always see everything.
 *   3. No allowing grant at all → object-level authorization is the
 *      enforcement layer's concern, with one refinement: principals whose
 *      only route is the broad platform `data` grant (the GraphQL/MCP
 *      transport requirement) keep their current unrestricted behavior,
 *      while everything else fails closed to `'none'` — which is what stops
 *      policy-hidden rows leaking through relation traversal into objects
 *      the caller was never granted.
 *
 * The resolver reads the ambient actor (Phase 12 request context). Outside
 * any actor scope — dispatcher deliveries, scheduled tasks, boot — policies
 * do not apply (system code keeps full access); inside a scope a `null`
 * actor is anonymous and resolves through the public role.
 */

import type { FieldMatchPolicy, PermissionGrant, RowPolicy } from '../../db/types.js';
import {
  currentActorId,
  currentActorRoleId,
  currentActor as getCurrentActor,
  hasActorScope,
} from '../../runtime/request-context.js';
import type { PermissionEngine, PrincipalRef } from './permission-engine.js';
import type { Action } from './policy-types.js';

export type { FieldMatchPolicy, RowPolicy };

/** The row-policy string forms. */
const ROW_POLICY_KEYWORDS = new Set(['all', 'own', 'none']);

/** The only supported field-match binding (see {@link FieldMatchPolicy}). */
const ACTOR_BINDING = 'actor.id';

/**
 * Validates one `rowPolicy` value (grant validation — RoleManager calls this
 * for every grant on every role mutation). Returns an error message, or null
 * when the policy is well-formed.
 */
export function validateRowPolicy(policy: unknown): string | null {
  if (typeof policy === 'string') {
    return ROW_POLICY_KEYWORDS.has(policy)
      ? null
      : `Unknown row policy "${policy}" — expected "all", "own", "none", or a { field, equals | contains } match`;
  }
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    return 'A row policy must be "all", "own", "none", or a { field, equals | contains } object';
  }
  const match = policy as Record<string, unknown>;
  if (typeof match.field !== 'string' || match.field.trim() === '') {
    return 'A field-match row policy requires a non-empty "field"';
  }
  const hasEquals = match.equals !== undefined;
  const hasContains = match.contains !== undefined;
  if (hasEquals === hasContains) {
    return `Row policy on field "${match.field}" must set exactly one of "equals" or "contains"`;
  }
  const binding = hasEquals ? match.equals : match.contains;
  if (binding !== ACTOR_BINDING) {
    return `Row policy on field "${match.field}" must bind to "${ACTOR_BINDING}" — it is the only supported value`;
  }
  const known = new Set(['field', 'equals', 'contains']);
  const extra = Object.keys(match).find((k) => !known.has(k));
  if (extra) return `Row policy on field "${match.field}" has an unknown key "${extra}"`;
  return null;
}

/**
 * Validates the `rowPolicy` of every grant in a set. Returns the first error
 * message, or null when all are acceptable.
 */
export function validateGrantRowPolicies(grants: PermissionGrant[]): string | null {
  for (const grant of grants) {
    if (grant.rowPolicy === undefined) continue;
    const problem = validateRowPolicy(grant.rowPolicy);
    if (problem) return `Grant on "${grant.resource}": ${problem}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compiled form — what DataService and the event filter consume
// ---------------------------------------------------------------------------

/** One OR-branch of a compiled policy, resolved to a physical column. */
export interface CompiledRowCondition {
  /** Physical column name on the object's table. */
  column: string;
  /** The object's declared column type (drives the `contains` SQL flavor). */
  columnType: string;
  op: 'equals' | 'contains';
  /** The acting principal's id the column is matched against. */
  value: string;
}

/**
 * A policy compiled for one (principal, action, object) triple: either
 * unrestricted, no rows, or a set of OR-ed conditions.
 */
export type CompiledRowPolicy =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'match'; conditions: CompiledRowCondition[] };

export const ROW_POLICY_ALL: CompiledRowPolicy = { kind: 'all' };
export const ROW_POLICY_NONE: CompiledRowPolicy = { kind: 'none' };

/** Resolves a policy's field reference to a physical column, or null. */
export type FieldColumnResolver = (
  objectName: string,
  field: string,
) => { column: string; columnType: string } | null;

/**
 * Unions the row policies of a set of allowing grants into one compiled
 * policy (most permissive wins, like the grants themselves):
 *
 *   - any absent/`'all'` policy → unrestricted;
 *   - `'none'` contributes nothing;
 *   - `'own'`/field matches become OR-ed conditions bound to `actorId`.
 *
 * Fail-closed edges: a condition whose field doesn't resolve on the object is
 * dropped (a policy naming a missing column matches nothing), and a `null`
 * actor cannot satisfy an actor-bound condition — so an all-conditions-dropped
 * union compiles to `'none'`.
 */
export function compileRowPolicies(
  objectName: string,
  policies: (RowPolicy | undefined)[],
  actorId: string | null,
  resolveField: FieldColumnResolver,
): CompiledRowPolicy {
  const conditions: CompiledRowCondition[] = [];
  for (const policy of policies) {
    if (policy === undefined || policy === 'all') return ROW_POLICY_ALL;
    if (policy === 'none') continue;
    if (actorId === null) continue; // actor-bound branch, no actor — unmatchable
    const match: FieldMatchPolicy =
      policy === 'own' ? { field: 'created_by', equals: ACTOR_BINDING } : policy;
    const resolved = resolveField(objectName, match.field);
    if (!resolved) continue; // unknown field — the branch can match nothing
    conditions.push({
      column: resolved.column,
      columnType: resolved.columnType,
      op: match.contains !== undefined ? 'contains' : 'equals',
      value: actorId,
    });
  }
  return conditions.length > 0 ? { kind: 'match', conditions } : ROW_POLICY_NONE;
}

/**
 * Evaluates a compiled policy against an in-memory row (physical column keys —
 * e.g. an event's before/after image). Mirrors the SQL semantics: `equals`
 * compares as strings; `contains` accepts a `text[]`/`jsonb` array value
 * (arrays from the driver, or a still-serialized JSON string).
 */
export function rowPolicyAllowsRow(
  policy: CompiledRowPolicy,
  row: Record<string, unknown> | null | undefined,
): boolean {
  if (policy.kind === 'all') return true;
  if (policy.kind === 'none' || !row) return false;
  return policy.conditions.some((cond) => {
    const value = row[cond.column];
    if (cond.op === 'equals') return value != null && String(value) === cond.value;
    return containsActor(value, cond.value);
  });
}

/** Whether an array-ish column value contains the actor id. */
function containsActor(value: unknown, actorId: string): boolean {
  let items = value;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      return false;
    }
  }
  return Array.isArray(items) && items.some((item) => String(item) === actorId);
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * The seam DataService consumes (kept minimal so tests can stub it without
 * a permission engine).
 */
export interface RowPolicyEnforcer {
  /** Compiles the ambient principal's row policy for (action, object). */
  resolve(action: Exclude<Action, 'manage'>, objectName: string): Promise<CompiledRowPolicy>;
}

/**
 * Resolves row policies from the permission engine's allowing grants — see the
 * module JSDoc for the model. One instance is wired into `DataService` (and
 * the realtime event filter) when RBAC enforcement is on; without enforcement
 * row policies do not apply, exactly like object-level RBAC.
 */
export class RowPolicyResolver implements RowPolicyEnforcer {
  constructor(
    private readonly engine: PermissionEngine,
    private readonly resolveField: FieldColumnResolver,
  ) {}

  /** Compiles the ambient (request-context) principal's policy. */
  async resolve(action: Exclude<Action, 'manage'>, objectName: string): Promise<CompiledRowPolicy> {
    // Background/system code (dispatcher, tasks, boot) runs outside any actor
    // scope and keeps full access; inside a scope, null actor = anonymous.
    if (!hasActorScope()) return ROW_POLICY_ALL;
    const actor = getCurrentActor();
    const principal: PrincipalRef | null = actor
      ? { userId: actor.userId, roleId: currentActorRoleId() }
      : null;
    return this.resolveFor(principal, action, objectName, currentActorId());
  }

  /**
   * Compiles an explicit principal's policy — used by per-event filtering,
   * where events are delivered outside the originating request's context.
   * `actorId` is the id row conditions bind to (user id, else API key id).
   */
  async resolveFor(
    principal: PrincipalRef | null,
    action: Exclude<Action, 'manage'>,
    objectName: string,
    actorId: string | null,
  ): Promise<CompiledRowPolicy> {
    const grants = await this.engine.allowingGrants(principal, action, objectName);
    if (grants.length === 0) return this.noGrantFallback(principal, action);
    return compileRowPolicies(
      objectName,
      grants.map((g) => g.rowPolicy),
      actorId,
      this.resolveField,
    );
  }

  /**
   * No grant allows the (action, object) pair. Object-level authorization is
   * the enforcement layer's job (REST 403s before DataService runs), but the
   * GraphQL/MCP transports admit principals holding the broad platform `data`
   * grant without per-object grants — those keep their pre-#7 unrestricted
   * behavior. Everyone else fails closed: this is the guard that keeps
   * relation traversal (expand=, GraphQL relation fields) from hydrating
   * objects the caller was never granted.
   */
  private async noGrantFallback(
    principal: PrincipalRef | null,
    action: Exclude<Action, 'manage'>,
  ): Promise<CompiledRowPolicy> {
    if (principal && (await this.engine.can(principal, action, 'data'))) return ROW_POLICY_ALL;
    return ROW_POLICY_NONE;
  }
}

/** The typed error DataService raises when a write violates a row policy. */
export const ROW_POLICY_DENIED = 'ROW_POLICY_DENIED';
