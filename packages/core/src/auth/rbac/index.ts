/**
 * RBAC module — roles, permissions, and enforcement.
 */

export { RoleManager } from './role-manager.js';
export type { RoleInput } from './role-manager.js';
export { PermissionEngine } from './permission-engine.js';
export { requirePermission, methodToAction } from './middleware.js';
export type { ResourceResolver } from './middleware.js';
export { installRbacEnforcement } from './enforcement.js';
export {
  ACTIONS,
  DEFAULT_ROLES,
  PLATFORM_RESOURCES,
  RESOURCE_WILDCARD,
  grantAllows,
} from './policy-types.js';
export type { Action, PermissionGrant } from './policy-types.js';
