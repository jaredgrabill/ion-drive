/**
 * Permission Engine — evaluates whether a principal may perform an action.
 *
 * Effective permissions are the union of:
 *   - the grants of every role assigned to the principal's user,
 *   - the grants of a role directly bound to the principal (API keys), and
 *   - for `read` checks, the grants of the built-in `public` role (issue #8) —
 *     "public" means everyone, so an authenticated caller is never allowed
 *     less than an anonymous one.
 *
 * The **anonymous** (null) principal is evaluated against the `public` role
 * only, and only ever for the `read` action — writes and administrative
 * actions are denied for anonymous callers regardless of what the role's
 * stored grants claim (belt-and-braces: the role's grant set is validated to
 * be read-only on named objects at write time, and re-filtered here at read
 * time in case the row was tampered with out-of-band).
 *
 * Evaluation is object-level today; field-level scoping is a future extension.
 */

import type { IonRole, PermissionGrant } from '../../db/types.js';
import type { AuthPrincipal } from '../types.js';
import {
  type Action,
  PUBLIC_ROLE_NAME,
  grantAllows,
  validatePublicRoleGrants,
} from './policy-types.js';
import type { RoleManager } from './role-manager.js';

export interface PermissionEngineOptions {
  /**
   * Whether the built-in `public` role is consulted at all (ION_PUBLIC_ROLE,
   * default true). Structurally on but inert until the role holds grants —
   * it is seeded empty. Set false to hard-disable anonymous evaluation even
   * when grants exist.
   */
  publicRole?: boolean;
}

export class PermissionEngine {
  private readonly publicRoleEnabled: boolean;

  constructor(
    private readonly roles: RoleManager,
    options: PermissionEngineOptions = {},
  ) {
    this.publicRoleEnabled = options.publicRole ?? true;
  }

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

  /**
   * The public role's grants, re-validated defensively: only grants that pass
   * {@link validatePublicRoleGrants} (read-only, named-object resources) are
   * honored, so a tampered `_ion_roles` row still cannot open a write or an
   * administrative surface. Empty when the role is disabled, missing, or empty.
   */
  private async getPublicGrants(): Promise<PermissionGrant[]> {
    if (!this.publicRoleEnabled) return [];
    const role = await this.roles.getByName(PUBLIC_ROLE_NAME);
    if (!role || role.permissions.length === 0) return [];
    return role.permissions.filter((grant) => validatePublicRoleGrants([grant]) === null);
  }

  /**
   * Whether any public read grant exists at all. Used by the enforcement layer
   * to decide if anonymous requests may reach the GraphQL/MCP transports (the
   * per-object check then happens per query field / tool call).
   */
  async hasPublicReadGrants(): Promise<boolean> {
    return (await this.getPublicGrants()).length > 0;
  }

  /** Returns true if the principal is allowed the action on the resource. */
  async can(principal: AuthPrincipal | null, action: Action, resource: string): Promise<boolean> {
    if (!principal) {
      // Anonymous: read-only, public-role-only. The action gate runs before
      // any grant is consulted, so no stored grant can open a write.
      if (action !== 'read') return false;
      const grants = await this.getPublicGrants();
      return grants.some((grant) => grantAllows(grant, 'read', resource));
    }

    const grants = await this.getEffectiveGrants(principal);
    if (grants.some((grant) => grantAllows(grant, action, resource))) return true;

    // Public grants apply to everyone — an authenticated caller can always
    // read at least what an anonymous one can. Read-only by construction.
    if (action === 'read') {
      const publicGrants = await this.getPublicGrants();
      return publicGrants.some((grant) => grantAllows(grant, 'read', resource));
    }
    return false;
  }
}
