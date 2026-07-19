/**
 * Event-access filter unit suite — object-level verdicts plus the issue #7
 * row-policy layer: an own-scoped reader's realtime feed only shows events
 * whose row image the compiled read policy matches (otherwise the SSE/GraphQL
 * streams would leak every row's changes past a scoped list).
 */

import { describe, expect, it } from 'vitest';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import {
  ROW_POLICY_ALL,
  ROW_POLICY_NONE,
  type RowPolicyResolver,
} from '../auth/rbac/row-policy.js';
import type { AuthPrincipal } from '../auth/types.js';
import { createEventAccessFilter } from './event-access.js';
import type { IonEvent } from './event-types.js';

const principal: AuthPrincipal = {
  via: 'session',
  userId: 'u1',
  user: null,
  session: null,
  apiKeyId: null,
  roleId: null,
};

/** Engine stub: read allowed on `players` and `events` only. */
const engine = {
  can: async (_p: unknown, _a: string, resource: string) =>
    resource === 'players' || resource === 'events',
} as unknown as PermissionEngine;

/** Resolver stub: `players` reads compile to created_by = u1; others open. */
const resolver = {
  resolveFor: async (_p: unknown, _a: string, objectName: string) =>
    objectName === 'players'
      ? {
          kind: 'match' as const,
          conditions: [
            { column: 'created_by', columnType: 'text', op: 'equals' as const, value: 'u1' },
          ],
        }
      : ROW_POLICY_ALL,
} as unknown as RowPolicyResolver;

function event(topic: string, after: Record<string, unknown> | null): IonEvent {
  return {
    id: 'e1',
    topic,
    payload: { after, before: null },
    occurred_at: new Date(),
  } as unknown as IonEvent;
}

describe('createEventAccessFilter + row policies', () => {
  it('row-scopes data events by their row image', async () => {
    const allowed = createEventAccessFilter({
      enforce: true,
      permissionEngine: engine,
      auth: principal,
      rowPolicies: resolver,
    });
    expect(
      await allowed('data.players.created', event('data.players.created', { created_by: 'u1' })),
    ).toBe(true);
    expect(
      await allowed('data.players.created', event('data.players.created', { created_by: 'u2' })),
    ).toBe(false);
    // Restricted policy + no row image (e.g. a link event): fail closed.
    expect(await allowed('data.players.linked', event('data.players.linked', null))).toBe(false);
    expect(await allowed('data.players.created')).toBe(false);
  });

  it('object-level denial still wins, and unrestricted objects pass', async () => {
    const allowed = createEventAccessFilter({
      enforce: true,
      permissionEngine: engine,
      auth: principal,
      rowPolicies: resolver,
    });
    expect(
      await allowed('data.secrets.created', event('data.secrets.created', { created_by: 'u1' })),
    ).toBe(false);
    // Hypothetical open object (resolver returns 'all'): row image irrelevant.
    const open = createEventAccessFilter({
      enforce: true,
      permissionEngine: { can: async () => true } as unknown as PermissionEngine,
      auth: principal,
      rowPolicies: resolver,
    });
    expect(
      await open('data.stats.created', event('data.stats.created', { created_by: 'u9' })),
    ).toBe(true);
  });

  it('without a resolver behavior is unchanged (object-level only)', async () => {
    const allowed = createEventAccessFilter({
      enforce: true,
      permissionEngine: engine,
      auth: principal,
    });
    expect(await allowed('data.players.created')).toBe(true);
  });

  it('a resolver compiling to none silences the object entirely', async () => {
    const closed = createEventAccessFilter({
      enforce: true,
      permissionEngine: engine,
      auth: principal,
      rowPolicies: {
        resolveFor: async () => ROW_POLICY_NONE,
      } as unknown as RowPolicyResolver,
    });
    expect(
      await closed('data.players.created', event('data.players.created', { created_by: 'u1' })),
    ).toBe(false);
  });
});
