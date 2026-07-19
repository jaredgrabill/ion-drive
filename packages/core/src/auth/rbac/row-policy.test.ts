/**
 * Row-policy unit suite (issue #7): grammar validation, grant validation,
 * union/compilation semantics (incl. the admin/service-key bypass), in-memory
 * row matching, and the resolver's grant-driven + fallback behavior.
 */

import { describe, expect, it } from 'vitest';
import type { IonRole } from '../../db/types.js';
import { runWithActor } from '../../runtime/request-context.js';
import { PermissionEngine } from './permission-engine.js';
import type { RoleManager } from './role-manager.js';
import {
  ROW_POLICY_ALL,
  ROW_POLICY_NONE,
  RowPolicyResolver,
  compileRowPolicies,
  rowPolicyAllowsRow,
  validateGrantRowPolicies,
  validateRowPolicy,
} from './row-policy.js';

// ---------------------------------------------------------------------------
// Grammar validation
// ---------------------------------------------------------------------------

describe('validateRowPolicy', () => {
  it('accepts the keyword forms', () => {
    expect(validateRowPolicy('all')).toBeNull();
    expect(validateRowPolicy('own')).toBeNull();
    expect(validateRowPolicy('none')).toBeNull();
  });

  it('accepts well-formed field matches', () => {
    expect(validateRowPolicy({ field: 'user_id', equals: 'actor.id' })).toBeNull();
    expect(validateRowPolicy({ field: 'participant_ids', contains: 'actor.id' })).toBeNull();
  });

  it('rejects unknown keywords, shapes, and bindings', () => {
    expect(validateRowPolicy('mine')).toMatch(/Unknown row policy/);
    expect(validateRowPolicy(42)).toMatch(/must be/);
    expect(validateRowPolicy(null)).toMatch(/must be/);
    expect(validateRowPolicy([])).toMatch(/must be/);
    expect(validateRowPolicy({})).toMatch(/non-empty "field"/);
    expect(validateRowPolicy({ field: 'x' })).toMatch(/exactly one of/);
    expect(validateRowPolicy({ field: 'x', equals: 'actor.id', contains: 'actor.id' })).toMatch(
      /exactly one of/,
    );
    expect(validateRowPolicy({ field: 'x', equals: 'actor.email' })).toMatch(/actor\.id/);
    expect(validateRowPolicy({ field: 'x', equals: 'actor.id', extra: true })).toMatch(
      /unknown key/,
    );
  });
});

describe('validateGrantRowPolicies', () => {
  it('passes grants without a rowPolicy (compat default)', () => {
    expect(validateGrantRowPolicies([{ resource: 'players', actions: ['read'] }])).toBeNull();
  });

  it('names the offending resource', () => {
    const err = validateGrantRowPolicies([
      { resource: 'players', actions: ['read'], rowPolicy: 'own' },
      { resource: 'matches', actions: ['read'], rowPolicy: 'nope' as never },
    ]);
    expect(err).toMatch(/Grant on "matches"/);
  });
});

// ---------------------------------------------------------------------------
// Compilation / union semantics
// ---------------------------------------------------------------------------

const resolveField = (_object: string, field: string) =>
  field === 'missing'
    ? null
    : { column: field, columnType: field.endsWith('_ids') ? 'json' : 'text' };

describe('compileRowPolicies', () => {
  it('an absent or "all" policy on any allowing grant is unrestricted (the bypass)', () => {
    expect(compileRowPolicies('players', [undefined], 'u1', resolveField)).toEqual(ROW_POLICY_ALL);
    expect(compileRowPolicies('players', ['own', undefined], 'u1', resolveField)).toEqual(
      ROW_POLICY_ALL,
    );
    expect(compileRowPolicies('players', ['none', 'all'], 'u1', resolveField)).toEqual(
      ROW_POLICY_ALL,
    );
  });

  it('compiles "own" to a created_by equality bound to the actor', () => {
    expect(compileRowPolicies('players', ['own'], 'u1', resolveField)).toEqual({
      kind: 'match',
      conditions: [{ column: 'created_by', columnType: 'text', op: 'equals', value: 'u1' }],
    });
  });

  it('ORs several restricted policies together', () => {
    const compiled = compileRowPolicies(
      'matches',
      ['own', { field: 'participant_ids', contains: 'actor.id' }],
      'u1',
      resolveField,
    );
    expect(compiled).toEqual({
      kind: 'match',
      conditions: [
        { column: 'created_by', columnType: 'text', op: 'equals', value: 'u1' },
        { column: 'participant_ids', columnType: 'json', op: 'contains', value: 'u1' },
      ],
    });
  });

  it('fails closed: only "none" grants, a null actor, or unresolvable fields', () => {
    expect(compileRowPolicies('players', ['none'], 'u1', resolveField)).toEqual(ROW_POLICY_NONE);
    expect(compileRowPolicies('players', ['own'], null, resolveField)).toEqual(ROW_POLICY_NONE);
    expect(
      compileRowPolicies('players', [{ field: 'missing', equals: 'actor.id' }], 'u1', resolveField),
    ).toEqual(ROW_POLICY_NONE);
  });
});

// ---------------------------------------------------------------------------
// In-memory row matching (the realtime event filter's evaluator)
// ---------------------------------------------------------------------------

describe('rowPolicyAllowsRow', () => {
  const own = compileRowPolicies('players', ['own'], 'u1', resolveField);
  const participant = compileRowPolicies(
    'matches',
    [{ field: 'participant_ids', contains: 'actor.id' }],
    'u1',
    resolveField,
  );

  it('mirrors the SQL semantics for equals', () => {
    expect(rowPolicyAllowsRow(own, { created_by: 'u1' })).toBe(true);
    expect(rowPolicyAllowsRow(own, { created_by: 'u2' })).toBe(false);
    expect(rowPolicyAllowsRow(own, { created_by: null })).toBe(false);
    expect(rowPolicyAllowsRow(own, null)).toBe(false);
  });

  it('matches contains against arrays and serialized JSON', () => {
    expect(rowPolicyAllowsRow(participant, { participant_ids: ['u1', 'u2'] })).toBe(true);
    expect(rowPolicyAllowsRow(participant, { participant_ids: '["u1","u2"]' })).toBe(true);
    expect(rowPolicyAllowsRow(participant, { participant_ids: ['u2'] })).toBe(false);
    expect(rowPolicyAllowsRow(participant, { participant_ids: 'not json' })).toBe(false);
    expect(rowPolicyAllowsRow(participant, {})).toBe(false);
  });

  it('all/none short-circuit', () => {
    expect(rowPolicyAllowsRow(ROW_POLICY_ALL, null)).toBe(true);
    expect(rowPolicyAllowsRow(ROW_POLICY_NONE, { created_by: 'u1' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resolver (grants → compiled policy, ambient actor, fallbacks)
// ---------------------------------------------------------------------------

function role(name: string, permissions: IonRole['permissions']): IonRole {
  return {
    id: `role_${name}`,
    name,
    description: null,
    permissions,
    is_system: false,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

const ROLES: Record<string, IonRole> = {
  admin: role('admin', [{ resource: '*', actions: ['manage'] }]),
  player: role('player', [
    { resource: 'players', actions: ['create', 'read', 'update'], rowPolicy: 'own' },
    {
      resource: 'matches',
      actions: ['read'],
      rowPolicy: { field: 'participant_ids', contains: 'actor.id' },
    },
  ]),
  dataWide: role('dataWide', [{ resource: 'data', actions: ['read'] }]),
  public: role('public', [{ resource: 'player_stats', actions: ['read'] }]),
};

function stubRoleManager(): RoleManager {
  const byUser: Record<string, IonRole[]> = {
    u_admin: [ROLES.admin as IonRole],
    u_player: [ROLES.player as IonRole],
    u_datawide: [ROLES.dataWide as IonRole],
  };
  return {
    getRolesForUser: async (userId: string) => byUser[userId] ?? [],
    getById: async (id: string) => Object.values(ROLES).find((r) => r.id === id),
    getByName: async (name: string) => (name === 'public' ? ROLES.public : undefined),
  } as unknown as RoleManager;
}

describe('RowPolicyResolver', () => {
  const engine = new PermissionEngine(stubRoleManager());
  const resolver = new RowPolicyResolver(engine, resolveField);
  const player = { userId: 'u_player', roleId: null };

  it('admin (manage *) bypasses row policies entirely', async () => {
    expect(
      await resolver.resolveFor({ userId: 'u_admin', roleId: null }, 'read', 'players', 'u_admin'),
    ).toEqual(ROW_POLICY_ALL);
  });

  it('an API key bound to the admin role bypasses too (the service key)', async () => {
    expect(
      await resolver.resolveFor(
        { userId: null, roleId: 'role_admin' },
        'update',
        'players',
        'key_1',
      ),
    ).toEqual(ROW_POLICY_ALL);
  });

  it('compiles the player grants per action/object', async () => {
    expect(await resolver.resolveFor(player, 'read', 'players', 'u_player')).toEqual({
      kind: 'match',
      conditions: [{ column: 'created_by', columnType: 'text', op: 'equals', value: 'u_player' }],
    });
    expect(await resolver.resolveFor(player, 'read', 'matches', 'u_player')).toEqual({
      kind: 'match',
      conditions: [
        { column: 'participant_ids', columnType: 'json', op: 'contains', value: 'u_player' },
      ],
    });
    // No update grant on matches → none (writes fail closed without a grant).
    expect(await resolver.resolveFor(player, 'update', 'matches', 'u_player')).toEqual(
      ROW_POLICY_NONE,
    );
  });

  it('unions unrestricted public read grants into authenticated reads', async () => {
    expect(await resolver.resolveFor(player, 'read', 'player_stats', 'u_player')).toEqual(
      ROW_POLICY_ALL,
    );
  });

  it('anonymous principals resolve through the public role only', async () => {
    expect(await resolver.resolveFor(null, 'read', 'player_stats', null)).toEqual(ROW_POLICY_ALL);
    expect(await resolver.resolveFor(null, 'read', 'players', null)).toEqual(ROW_POLICY_NONE);
    expect(await resolver.resolveFor(null, 'create', 'player_stats', null)).toEqual(
      ROW_POLICY_NONE,
    );
  });

  it('no object grant: broad platform-data access stays unrestricted, others fail closed', async () => {
    // The GraphQL/MCP transport path — read on the `data` platform resource.
    expect(
      await resolver.resolveFor(
        { userId: 'u_datawide', roleId: null },
        'read',
        'players',
        'u_datawide',
      ),
    ).toEqual(ROW_POLICY_ALL);
    // A player traversing a relation into an ungranted object sees nothing.
    expect(await resolver.resolveFor(player, 'read', 'secrets_vault', 'u_player')).toEqual(
      ROW_POLICY_NONE,
    );
  });

  it('resolve() reads the ambient actor scope', async () => {
    // Outside any scope: system code, unrestricted.
    expect(await resolver.resolve('read', 'players')).toEqual(ROW_POLICY_ALL);

    // Inside a scope with a session actor: that principal's compiled policy.
    const scoped = await runWithActor({ userId: 'u_player', apiKeyId: null, via: 'session' }, () =>
      resolver.resolve('read', 'players'),
    );
    expect(scoped).toEqual({
      kind: 'match',
      conditions: [{ column: 'created_by', columnType: 'text', op: 'equals', value: 'u_player' }],
    });

    // Inside a scope with no actor: anonymous.
    const anon = await runWithActor(null, () => resolver.resolve('read', 'players'));
    expect(anon).toEqual(ROW_POLICY_NONE);

    // API-key actor: the bound role resolves via options.roleId.
    const viaKey = await runWithActor(
      { userId: null, apiKeyId: 'key_1', via: 'api_key' },
      () => resolver.resolve('update', 'players'),
      { roleId: 'role_admin' },
    );
    expect(viaKey).toEqual(ROW_POLICY_ALL);
  });
});
