import { describe, expect, it } from 'vitest';
import type { IonRole } from '../../db/types.js';
import type { AuthPrincipal } from '../types.js';
import { PermissionEngine } from './permission-engine.js';
import { validatePublicRoleGrants } from './policy-types.js';
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

/**
 * Minimal RoleManager stub: userId "u_admin" → admin, "u_viewer" → viewer.
 * `publicRole` is what getByName('public') returns (default: absent).
 */
function stubRoleManager(publicRole?: IonRole): RoleManager {
  const byUser: Record<string, IonRole[]> = {
    u_admin: [ROLES.admin as IonRole],
    u_viewer: [ROLES.viewer as IonRole],
    u_contacts: [ROLES.contactsEditor as IonRole],
  };
  return {
    getRolesForUser: async (userId: string) => byUser[userId] ?? [],
    getById: async (id: string) => Object.values(ROLES).find((r) => r.id === id),
    getByName: async (name: string) => (name === 'public' ? publicRole : undefined),
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

// ---------------------------------------------------------------------------
// Public role — anonymous (null principal) evaluation (issue #8)
// ---------------------------------------------------------------------------

describe('PermissionEngine — public role', () => {
  const publicRole = role('public', [{ resource: 'player_stats', actions: ['read'] }]);

  it('grants anonymous read on a publicly granted object only', async () => {
    const engine = new PermissionEngine(stubRoleManager(publicRole));
    expect(await engine.can(null, 'read', 'player_stats')).toBe(true);
    expect(await engine.can(null, 'read', 'invoices')).toBe(false);
  });

  it('denies every non-read action for the anonymous principal', async () => {
    const engine = new PermissionEngine(stubRoleManager(publicRole));
    for (const action of ['create', 'update', 'delete', 'manage'] as const) {
      expect(await engine.can(null, action, 'player_stats')).toBe(false);
    }
  });

  it('ignores tampered write/wildcard/platform grants on the public role (belt-and-braces)', async () => {
    const tampered = role('public', [
      // None of these can be created through the API (validated 400) — this
      // simulates a row edited directly in the database.
      { resource: 'player_stats', actions: ['manage'] },
      { resource: '*', actions: ['read'] },
      { resource: 'secrets', actions: ['read'] },
    ]);
    const engine = new PermissionEngine(stubRoleManager(tampered));
    expect(await engine.can(null, 'read', 'player_stats')).toBe(false);
    expect(await engine.can(null, 'read', 'anything')).toBe(false);
    expect(await engine.can(null, 'read', 'secrets')).toBe(false);
    expect(await engine.hasPublicReadGrants()).toBe(false);
  });

  it('is inert when the role is missing or empty', async () => {
    expect(await new PermissionEngine(stubRoleManager()).can(null, 'read', 'player_stats')).toBe(
      false,
    );
    const empty = new PermissionEngine(stubRoleManager(role('public', [])));
    expect(await empty.can(null, 'read', 'player_stats')).toBe(false);
    expect(await empty.hasPublicReadGrants()).toBe(false);
  });

  it('can be hard-disabled via the publicRole option (ION_PUBLIC_ROLE=false)', async () => {
    const engine = new PermissionEngine(stubRoleManager(publicRole), { publicRole: false });
    expect(await engine.can(null, 'read', 'player_stats')).toBe(false);
    expect(await engine.hasPublicReadGrants()).toBe(false);
  });

  it('reports grant presence for the transport-level gate', async () => {
    expect(await new PermissionEngine(stubRoleManager(publicRole)).hasPublicReadGrants()).toBe(
      true,
    );
  });

  it('unions public grants into authenticated principals (never less than anonymous)', async () => {
    const engine = new PermissionEngine(stubRoleManager(publicRole));
    // u_contacts has no grant on player_stats of its own.
    const p = sessionPrincipal('u_contacts');
    expect(await engine.can(p, 'read', 'player_stats')).toBe(true);
    expect(await engine.can(p, 'update', 'player_stats')).toBe(false);
  });
});

describe('validatePublicRoleGrants', () => {
  it('accepts read grants on named data objects', () => {
    expect(
      validatePublicRoleGrants([
        { resource: 'player_stats', actions: ['read'] },
        { resource: 'match_history', actions: ['read'] },
      ]),
    ).toBeNull();
    expect(validatePublicRoleGrants([])).toBeNull();
  });

  it('rejects any non-read action', () => {
    for (const action of ['create', 'update', 'delete', 'manage', '*']) {
      expect(
        validatePublicRoleGrants([{ resource: 'player_stats', actions: ['read', action] }]),
      ).toMatch(/only hold "read" grants/);
    }
  });

  it('rejects the resource wildcard and platform resources', () => {
    expect(validatePublicRoleGrants([{ resource: '*', actions: ['read'] }])).toMatch(
      /cannot be granted the "\*" resource/,
    );
    for (const resource of ['schema', 'data', 'secrets', 'roles', 'users', 'api_keys']) {
      expect(validatePublicRoleGrants([{ resource, actions: ['read'] }])).toMatch(
        /platform resource/,
      );
    }
  });

  it('rejects empty action lists', () => {
    expect(validatePublicRoleGrants([{ resource: 'player_stats', actions: [] }])).toMatch(
      /no actions/,
    );
  });
});
