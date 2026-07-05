/**
 * Permission Engine — evaluates whether a principal may perform an action.
 *
 * Effective permissions are the union of:
 *   - the grants of every role assigned to the principal's user, and
 *   - the grants of a role directly bound to the principal (API keys).
 *
 * Evaluation is object-level today; field-level scoping is a future extension.
 */

import type { IonRole, PermissionGrant } from '../../db/types.js';
import type { AuthPrincipal } from '../types.js';
import { type Action, grantAllows } from './policy-types.js';
import type { RoleManager } from './role-manager.js';

export class PermissionEngine {
  constructor(private readonly roles: RoleManager) {}

  /** Resolves all roles that apply to a principal (user roles + bound role). */
  async getEffectiveRoles(principal: AuthPrincipal): Promise<IonRole[]> {
    const collected = new Map<string, IonRole>();

    if (principal.userId) {
      for (const role of await this.roles.getRolesForUser(principal.userId)) {
        collected.set(role.id, role);
      }
    }
    if (principal.roleId) {
      const role = await this.roles.getById(principal.roleId);
      if (role) collected.set(role.id, role);
    }
    return [...collected.values()];
  }

  async getEffectiveRoleNames(principal: AuthPrincipal): Promise<string[]> {
    return (await this.getEffectiveRoles(principal)).map((r) => r.name);
  }

  private async getEffectiveGrants(principal: AuthPrincipal): Promise<PermissionGrant[]> {
    const roles = await this.getEffectiveRoles(principal);
    return roles.flatMap((r) => r.permissions);
  }

  /** Returns true if the principal is allowed the action on the resource. */
  async can(principal: AuthPrincipal | null, action: Action, resource: string): Promise<boolean> {
    if (!principal) return false;
    const grants = await this.getEffectiveGrants(principal);
    return grants.some((grant) => grantAllows(grant, action, resource));
  }
}
