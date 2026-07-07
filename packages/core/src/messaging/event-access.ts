/**
 * Per-event RBAC filter shared by the realtime consumers (Phase 12 SSE
 * stream, Phase 13 GraphQL subscriptions): `data.<object>.*` events require
 * `read` on the object, anything else `read` on the fallback resource
 * (`events`). Verdicts are cached per connection/subscription, so the
 * permission engine is consulted once per distinct resource for the life of
 * the stream. Unauthorized events are silently skipped — a feed shows you
 * what you may see, it does not error on what you may not.
 */

import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { AuthPrincipal } from '../auth/types.js';

export interface EventAccessOptions {
  /** When false every event passes (RBAC enforcement is off). */
  enforce: boolean;
  permissionEngine: PermissionEngine;
  /** The connected principal; null (under enforcement) sees nothing. */
  auth: AuthPrincipal | null;
  /** Resource guarding non-data topics (default `events`). */
  fallbackResource?: string;
}

/** Builds the `(topic) => allowed` predicate with its per-connection verdict cache. */
export function createEventAccessFilter(
  options: EventAccessOptions,
): (topic: string) => Promise<boolean> {
  const { enforce, permissionEngine, auth } = options;
  const fallback = options.fallbackResource ?? 'events';
  const verdicts = new Map<string, Promise<boolean>>();

  return (topic: string): Promise<boolean> => {
    if (!enforce) return Promise.resolve(true);
    if (!auth) return Promise.resolve(false);
    const segments = topic.split('.');
    const resource = segments[0] === 'data' && segments[1] ? segments[1] : fallback;
    let verdict = verdicts.get(resource);
    if (!verdict) {
      verdict = permissionEngine.can(auth, 'read', resource);
      verdicts.set(resource, verdict);
    }
    return verdict;
  };
}
