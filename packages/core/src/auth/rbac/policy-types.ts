/**
 * RBAC policy vocabulary.
 *
 * A permission is a grant of one or more **actions** on a **resource**. A
 * resource is either a data-object name, one of the platform resources below,
 * or the wildcard `*` (all resources). The `manage` action is a superset that
 * implies create/read/update/delete plus administrative operations.
 */

import type { PermissionGrant } from '../../db/types.js';

export type { PermissionGrant };

export const ACTIONS = ['create', 'read', 'update', 'delete', 'manage'] as const;
export type Action = (typeof ACTIONS)[number];

/** Matches any resource in a grant. */
export const RESOURCE_WILDCARD = '*';

/**
 * The seeded role auto-assigned to anonymous (guest) users. Its assignments are
 * excluded from the first-admin bootstrap accounting (see RoleManager) so a
 * guest arriving before the first real sign-up can neither become admin nor
 * close the bootstrap window.
 *
 * Distinct from {@link PUBLIC_ROLE_NAME}: `anonymous` covers **guest users**
 * created by anonymous sign-in (they hold a real session and evaluate as
 * authenticated principals through their assigned roles); `public` covers
 * requests with **no credential at all** (the null principal).
 */
export const ANONYMOUS_ROLE_NAME = 'anonymous';

/**
 * Name of the built-in role evaluated for the **anonymous** (null) principal —
 * requests that present no credential at all (issue #8). Admins grant `read`
 * on specific data objects to it exactly like any other role; the permission
 * engine consults it when no principal is present (and unions its grants into
 * every authenticated principal's effective grants, since "public" means
 * everyone). It is deliberately fenced in:
 *
 *   - it can hold only `read` grants on named data objects (see
 *     {@link validatePublicRoleGrants}),
 *   - it cannot be assigned to users or bound to API keys,
 *   - it cannot be renamed or deleted, and
 *   - it never satisfies `requirePermission` guards (admin routes), which
 *     401 unauthenticated requests before consulting the engine.
 */
export const PUBLIC_ROLE_NAME = 'public';

/**
 * Platform (non-data-object) resources that RBAC can protect. Data objects are
 * referenced by their own name; these cover administrative surfaces.
 */
export const PLATFORM_RESOURCES = {
  schema: 'schema',
  data: 'data',
  secrets: 'secrets',
  config: 'config',
  users: 'users',
  roles: 'roles',
  apiKeys: 'api_keys',
  tasks: 'tasks',
  blocks: 'blocks',
  logs: 'logs',
  stats: 'stats',
  events: 'events',
  webhooks: 'webhooks',
} as const;

/**
 * Returns true if a grant covers the requested action on the requested resource.
 * `manage` implies every action; a `*` in the actions list also matches.
 */
export function grantAllows(grant: PermissionGrant, action: Action, resource: string): boolean {
  const resourceMatches = grant.resource === RESOURCE_WILDCARD || grant.resource === resource;
  if (!resourceMatches) return false;
  return (
    grant.actions.includes('manage') ||
    grant.actions.includes(RESOURCE_WILDCARD) ||
    grant.actions.includes(action)
  );
}

/**
 * Validates the grant set of the {@link PUBLIC_ROLE_NAME} role. Returns an
 * error message when a grant would exceed the public role's fence, or null
 * when the set is acceptable. The rules (issue #8 safety rails):
 *
 *   - every grant's actions must be exactly `read` — no create/update/delete,
 *     no `manage`, no `*` action;
 *   - the resource must be a **named data object** — the `*` wildcard and the
 *     platform resources (schema, secrets, roles, …) are rejected, so a public
 *     grant can never open an administrative surface or "everything".
 */
export function validatePublicRoleGrants(grants: PermissionGrant[]): string | null {
  const platformResources = new Set<string>(Object.values(PLATFORM_RESOURCES));
  for (const grant of grants) {
    const badAction = grant.actions.find((a) => a !== 'read');
    if (badAction !== undefined) {
      return `The public role can only hold "read" grants — remove action "${badAction}" on "${grant.resource}"`;
    }
    if (grant.actions.length === 0) {
      return `The public role grant on "${grant.resource}" has no actions`;
    }
    if (grant.resource === RESOURCE_WILDCARD) {
      return 'The public role cannot be granted the "*" resource — grant read on specific data objects instead';
    }
    if (platformResources.has(grant.resource)) {
      return `The public role cannot be granted platform resource "${grant.resource}" — only named data objects`;
    }
  }
  return null;
}

/** Well-known default roles seeded on first run. */
export const DEFAULT_ROLES: {
  name: string;
  description: string;
  permissions: PermissionGrant[];
}[] = [
  {
    name: 'admin',
    description: 'Full access to all data and platform administration.',
    permissions: [{ resource: RESOURCE_WILDCARD, actions: ['manage'] }],
  },
  {
    name: 'editor',
    description: 'Read and write all data objects; no platform administration.',
    permissions: [{ resource: RESOURCE_WILDCARD, actions: ['create', 'read', 'update', 'delete'] }],
  },
  {
    name: 'viewer',
    description: 'Read-only access to all data objects.',
    permissions: [{ resource: RESOURCE_WILDCARD, actions: ['read'] }],
  },
  {
    name: ANONYMOUS_ROLE_NAME,
    description:
      'Guest users created by anonymous sign-in (ION_ANONYMOUS_AUTH). Starts with no ' +
      'grants — deliberately minimal; edit this role to allow what guests may do.',
    permissions: [],
  },
  {
    // Empty by default, so seeding it is inert until an admin grants read on
    // a specific object (issue #8 — per-object public read access).
    name: PUBLIC_ROLE_NAME,
    description:
      'Anonymous (no-credential) requests. Grant read on specific data objects to expose ' +
      'them publicly; read-only by design and never assignable to users or API keys.',
    permissions: [],
  },
];
