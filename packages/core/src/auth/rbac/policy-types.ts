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
];
