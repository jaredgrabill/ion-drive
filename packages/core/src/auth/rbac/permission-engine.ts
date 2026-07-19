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
import {
  type Action,
  PUBLIC_ROLE_NAME,
  grantAllows,
  validatePublicRoleGrants,
} from './policy-types.js';
import type { RoleManager } from './role-manager.js';

/**
 * The minimal principal shape the engine evaluates: a user id (session logins,
 * user-bound API keys) and/or an explicit role binding (API keys). The full
 * {@link AuthPrincipal} is structurally assignable, so route-layer callers
 * pass `request.auth` unchanged; the row-policy resolver (issue #7) builds one
 * from the ambient request context instead.
 */
export interface PrincipalRef {
  userId: string | null;
  roleId: string | null;
}

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
  async getEffectiveRoles(principal: PrincipalRef): Promise<IonRole[]> {
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

  async getEffectiveRoleNames(principal: PrincipalRef): Promise<string[]> {
    return (await this.getEffectiveRoles(principal)).map((r) => r.name);
  }

  private async getEffectiveGrants(principal: PrincipalRef): Promise<PermissionGrant[]> {
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
  async can(principal: PrincipalRef | null, action: Action, resource: string): Promise<boolean> {
    return (await this.allowingGrants(principal, action, resource)).length > 0;
  }

  /**
   * Every grant that allows the action on the resource — the row-policy
   * resolver (issue #7) unions their `rowPolicy` values, so the shape of "who
   * may act" and "on which rows" comes from one evaluation. Anonymous
   * principals see only the (re-validated, read-only) public grants; for
   * `read`, public grants union into every authenticated principal's set too —
   * an authenticated caller is never allowed less than an anonymous one.
   */
  async allowingGrants(
    principal: PrincipalRef | null,
    action: Action,
    resource: string,
  ): Promise<PermissionGrant[]> {
    if (!principal) {
      // Anonymous: read-only, public-role-only. The action gate runs before
      // any grant is consulted, so no stored grant can open a write.
      if (action !== 'read') return [];
      const grants = await this.getPublicGrants();
      return grants.filter((grant) => grantAllows(grant, 'read', resource));
    }

    const grants = (await this.getEffectiveGrants(principal)).filter((grant) =>
      grantAllows(grant, action, resource),
    );
    if (action === 'read') {
      const publicGrants = await this.getPublicGrants();
      grants.push(...publicGrants.filter((grant) => grantAllows(grant, 'read', resource)));
    }
    return grants;
  }
}
