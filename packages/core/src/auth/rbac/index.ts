/**
 * RBAC module — roles, permissions, and enforcement.
 */

export { RoleManager, RoleValidationError } from './role-manager.js';
export type { RoleInput } from './role-manager.js';
export { PermissionEngine } from './permission-engine.js';
export type { PermissionEngineOptions, PrincipalRef } from './permission-engine.js';
export {
  ROW_POLICY_ALL,
  ROW_POLICY_DENIED,
  ROW_POLICY_NONE,
  RowPolicyResolver,
  compileRowPolicies,
  rowPolicyAllowsRow,
  validateGrantRowPolicies,
  validateRowPolicy,
} from './row-policy.js';
export type {
  CompiledRowCondition,
  CompiledRowPolicy,
  FieldColumnResolver,
  FieldMatchPolicy,
  RowPolicy,
  RowPolicyEnforcer,
} from './row-policy.js';
export { requirePermission, methodToAction } from './middleware.js';
export type { ResourceResolver } from './middleware.js';
export { installRbacEnforcement } from './enforcement.js';
export type { EnforcementOptions } from './enforcement.js';
export {
  ACTIONS,
  DEFAULT_ROLES,
  PLATFORM_RESOURCES,
  PUBLIC_ROLE_NAME,
  RESOURCE_WILDCARD,
  grantAllows,
  validatePublicRoleGrants,
} from './policy-types.js';
export type { Action, PermissionGrant } from './policy-types.js';
