import { describe, expect, it } from 'vitest';
import type { IonRole } from '../../db/types.js';
import type { AuthPrincipal } from '../types.js';
import { PermissionEngine } from './permission-engine.js';
import type { RoleManager } from './role-manager.js';

function role(name: string, permissions: IonRole['permissions']): IonRole {
  return {
    id: `role_${name}`,
    name,
    description: null,
    permissions,
    is_system: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

const ROLES: Record<string, IonRole> = {
  admin: role('admin', [{ resource: '*', actions: ['manage'] }]),
  viewer: role('viewer', [{ resource: '*', actions: ['read'] }]),
  contactsEditor: role('contactsEditor', [{ resource: 'contacts', actions: ['read', 'update'] }]),
};

/** Minimal RoleManager stub: userId "u_admin" → admin, "u_viewer" → viewer. */
function stubRoleManager(): RoleManager {
  const byUser: Record<string, IonRole[]> = {
    u_admin: [ROLES.admin as IonRole],
    u_viewer: [ROLES.viewer as IonRole],
    u_contacts: [ROLES.contactsEditor as IonRole],
  };
  return {
    getRolesForUser: async (userId: string) => byUser[userId] ?? [],
    getById: async (id: string) => Object.values(ROLES).find((r) => r.id === id),
  } as unknown as RoleManager;
}

function sessionPrincipal(userId: string): AuthPrincipal {
  return { via: 'session', userId, user: null, session: null, apiKeyId: null, roleId: null };
}

describe('PermissionEngine', () => {
  const engine = new PermissionEngine(stubRoleManager());

  it('denies anonymous principals', async () => {
    expect(await engine.can(null, 'read', 'contacts')).toBe(false);
  });

  it('grants everything to admin (manage *)', async () => {
    const p = sessionPrincipal('u_admin');
    expect(await engine.can(p, 'read', 'contacts')).toBe(true);
    expect(await engine.can(p, 'delete', 'anything')).toBe(true);
    expect(await engine.can(p, 'manage', 'secrets')).toBe(true);
  });

  it('limits viewer to read', async () => {
    const p = sessionPrincipal('u_viewer');
    expect(await engine.can(p, 'read', 'contacts')).toBe(true);
    expect(await engine.can(p, 'create', 'contacts')).toBe(false);
    expect(await engine.can(p, 'delete', 'contacts')).toBe(false);
  });

  it('scopes object-level grants to the named resource', async () => {
    const p = sessionPrincipal('u_contacts');
    expect(await engine.can(p, 'read', 'contacts')).toBe(true);
    expect(await engine.can(p, 'update', 'contacts')).toBe(true);
    expect(await engine.can(p, 'create', 'contacts')).toBe(false);
    expect(await engine.can(p, 'read', 'invoices')).toBe(false);
  });

  it('resolves a role bound directly to an API key principal', async () => {
    const apiKeyPrincipal: AuthPrincipal = {
      via: 'api_key',
      userId: null,
      user: null,
      session: null,
      apiKeyId: 'k1',
      roleId: 'role_viewer',
    };
    expect(await engine.can(apiKeyPrincipal, 'read', 'contacts')).toBe(true);
    expect(await engine.can(apiKeyPrincipal, 'update', 'contacts')).toBe(false);
  });

  it('lists effective role names', async () => {
    expect(await engine.getEffectiveRoleNames(sessionPrincipal('u_admin'))).toEqual(['admin']);
  });
});
