/**
 * Per-event RBAC filter shared by the realtime consumers (Phase 12 SSE
 * stream, Phase 13 GraphQL subscriptions): `data.<object>.*` events require
 * `read` on the object, anything else `read` on the fallback resource
 * (`events`). Verdicts are cached per connection/subscription, so the
 * permission engine is consulted once per distinct resource for the life of
 * the stream. Unauthorized events are silently skipped — a feed shows you
 * what you may see, it does not error on what you may not.
 *
 * **Row policies (issue #7):** when a resolver is wired, data events are
 * additionally checked against the principal's compiled *read* row policy,
 * evaluated in memory against the event's row image (`after`, else
 * `before`) — otherwise an own-scoped reader would still see every row's
 * changes stream past. Events without a row image (link events) fail closed
 * under a restricted policy. Policies are compiled once per object per
 * connection, like the object-level verdicts.
 */

import type { PermissionEngine, PrincipalRef } from '../auth/rbac/permission-engine.js';
import {
  type CompiledRowPolicy,
  ROW_POLICY_ALL,
  type RowPolicyResolver,
  rowPolicyAllowsRow,
} from '../auth/rbac/row-policy.js';
import type { AuthPrincipal } from '../auth/types.js';
import type { IonEvent } from './event-types.js';

export interface EventAccessOptions {
  /** When false every event passes (RBAC enforcement is off). */
  enforce: boolean;
  permissionEngine: PermissionEngine;
  /** The connected principal; null (under enforcement) sees nothing. */
  auth: AuthPrincipal | null;
  /** Resource guarding non-data topics (default `events`). */
  fallbackResource?: string;
  /** Row-level read scoping for data events (issue #7); absent = object-level only. */
  rowPolicies?: RowPolicyResolver;
}

/**
 * Builds the `(topic, event?) => allowed` predicate with its per-connection
 * verdict + policy caches. Callers that have the full event should pass it so
 * row policies can see the row image; topic-only calls skip the row check.
 */
export function createEventAccessFilter(
  options: EventAccessOptions,
): (topic: string, event?: IonEvent) => Promise<boolean> {
  const { enforce, permissionEngine, auth, rowPolicies } = options;
  const fallback = options.fallbackResource ?? 'events';
  const verdicts = new Map<string, Promise<boolean>>();
  const policies = new Map<string, Promise<CompiledRowPolicy>>();

  const principal: PrincipalRef | null = auth ? { userId: auth.userId, roleId: auth.roleId } : null;
  const actorId = auth ? (auth.userId ?? auth.apiKeyId) : null;

  const policyFor = (objectName: string): Promise<CompiledRowPolicy> => {
    if (!rowPolicies) return Promise.resolve(ROW_POLICY_ALL);
    let policy = policies.get(objectName);
    if (!policy) {
      policy = rowPolicies.resolveFor(principal, 'read', objectName, actorId);
      policies.set(objectName, policy);
    }
    return policy;
  };

  const objectLevelAllowed = (resource: string): Promise<boolean> => {
    let verdict = verdicts.get(resource);
    if (!verdict && auth) {
      verdict = permissionEngine.can(auth, 'read', resource);
      verdicts.set(resource, verdict);
    }
    return verdict ?? Promise.resolve(false);
  };

  // Row-level scoping applies to data events only; the row image is the
  // after (else before) snapshot the CRUD payload carries. A restricted
  // policy with no payload fails closed.
  const rowLevelAllowed = async (objectName: string, event?: IonEvent): Promise<boolean> => {
    const policy = await policyFor(objectName);
    if (policy.kind === 'all') return true;
    if (!event) return false;
    const payload = event.payload as { after?: unknown; before?: unknown } | null;
    const row = (payload?.after ?? payload?.before ?? null) as Record<string, unknown> | null;
    return rowPolicyAllowsRow(policy, row);
  };

  return async (topic: string, event?: IonEvent): Promise<boolean> => {
    if (!enforce) return true;
    if (!auth) return false;
    const segments = topic.split('.');
    const objectName = segments[0] === 'data' && segments[1] ? segments[1] : null;
    if (!(await objectLevelAllowed(objectName ?? fallback))) return false;
    if (!objectName || !rowPolicies) return true;
    return rowLevelAllowed(objectName, event);
  };
}
