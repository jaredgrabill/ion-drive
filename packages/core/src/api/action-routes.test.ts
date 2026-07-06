/**
 * Route-level tests for the Phase 14 action/hook HTTP surface: the
 * `POST /blocks/:block/actions/:action` catch-all (validation, RBAC, error
 * mapping) and the raw-body webhook catch-all at `/hooks/:block/:hook`.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import type { AuthPrincipal } from '../auth/types.js';
import { ActionExecutor } from '../blocks/action-executor.js';
import { ActionRegistry } from '../blocks/action-registry.js';
import { parseManifest } from '../blocks/block-manifest.js';
import type { InstalledBlock } from '../blocks/block-types.js';
import type { BlockEngine } from '../blocks/index.js';
import type { IonDriveConfig, SecretsManager } from '../config/index.js';
import type { DataService } from '../data/data-service.js';
import type { LoggerProvider } from '../logging/logger-provider.js';
import { registerBlockRoutes } from './block-routes.js';
import { registerHookRoutes } from './hook-routes.js';

const stubLogger: LoggerProvider = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return stubLogger;
  },
};

const manifest = parseManifest({
  name: 'invoicing',
  title: 'Invoicing',
  actions: [{ name: 'ping', input: { type: 'object' } }],
  hooks: [{ name: 'stripe' }],
});

const installedRow: InstalledBlock = {
  name: 'invoicing',
  version: manifest.version,
  title: manifest.title,
  status: 'installed',
  createdObjects: [],
  manifest,
  installedAt: new Date(),
  updatedAt: new Date(),
};

function buildRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registry.registerAction({
    block: 'invoicing',
    name: 'ping',
    input: z.object({ value: z.number() }),
    handler: async (ctx) => ({ pong: ctx.input.value }),
  });
  registry.registerHook({
    block: 'invoicing',
    name: 'stripe',
    handler: async (ctx) => ({
      status: 202,
      body: { bytes: ctx.rawBody.length, sig: ctx.headers['stripe-signature'] ?? null },
    }),
  });
  return registry;
}

function buildExecutor(registry: ActionRegistry): ActionExecutor {
  return new ActionExecutor({
    registry,
    getInstalledBlock: async (name) => (name === 'invoicing' ? installedRow : undefined),
    listInstalledBlocks: async () => [installedRow],
    dataService: {} as DataService,
    secrets: {} as SecretsManager,
    config: {} as IonDriveConfig,
    logger: stubLogger,
  });
}

/** A block engine stub exposing just what the routes touch. */
function stubBlockEngine(registry: ActionRegistry): BlockEngine {
  return {
    actionRegistry: registry,
    listInstalled: async () => [installedRow],
    getInstalled: async (name: string) => (name === 'invoicing' ? installedRow : undefined),
  } as unknown as BlockEngine;
}

describe('POST /blocks/:block/actions/:action', () => {
  let allow: boolean;
  let principal: AuthPrincipal | null;
  const permissionEngine = {
    can: async () => allow,
  } as unknown as PermissionEngine;

  async function buildServer(enforce: boolean) {
    const registry = buildRegistry();
    const server = Fastify();
    // Minimal stand-in for the session middleware.
    server.decorateRequest('auth', null);
    server.addHook('onRequest', async (request) => {
      request.auth = principal;
    });
    await server.register(
      registerBlockRoutes({
        blockEngine: stubBlockEngine(registry),
        permissionEngine,
        actionExecutor: buildExecutor(registry),
        enforce,
      }),
      { prefix: '/blocks' },
    );
    return server;
  }

  beforeEach(() => {
    allow = true;
    principal = { kind: 'session', userId: 'u1' } as unknown as AuthPrincipal;
  });

  it('invokes a registered action and returns its result', async () => {
    const server = await buildServer(false);
    const res = await server.inject({
      method: 'POST',
      url: '/blocks/invoicing/actions/ping',
      payload: { value: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { pong: 7 } });
  });

  it('400s invalid input with issues', async () => {
    const server = await buildServer(false);
    const res = await server.inject({
      method: 'POST',
      url: '/blocks/invoicing/actions/ping',
      payload: { value: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0]).toContain('value');
  });

  it('404s unknown blocks and undeclared actions', async () => {
    const server = await buildServer(false);
    expect(
      (await server.inject({ method: 'POST', url: '/blocks/nope/actions/ping', payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/blocks/invoicing/actions/undeclared',
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });

  it('enforces RBAC when enabled: 401 unauthenticated, 403 denied', async () => {
    const server = await buildServer(true);

    principal = null;
    const unauthed = await server.inject({
      method: 'POST',
      url: '/blocks/invoicing/actions/ping',
      payload: { value: 1 },
    });
    expect(unauthed.statusCode).toBe(401);

    principal = { kind: 'session', userId: 'u1' } as unknown as AuthPrincipal;
    allow = false;
    const denied = await server.inject({
      method: 'POST',
      url: '/blocks/invoicing/actions/ping',
      payload: { value: 1 },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toContain('update on "blocks"');

    allow = true;
    const ok = await server.inject({
      method: 'POST',
      url: '/blocks/invoicing/actions/ping',
      payload: { value: 1 },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('lists declared and registered actions at GET /blocks/actions', async () => {
    const server = await buildServer(false);
    const res = await server.inject({ method: 'GET', url: '/blocks/actions' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.declared.map((a: { name: string }) => a.name)).toEqual(['ping']);
    expect(data.registered.actions[0]).toMatchObject({ block: 'invoicing', name: 'ping' });
    expect(data.registered.hooks[0]).toMatchObject({ block: 'invoicing', name: 'stripe' });
  });
});

describe('hooks catch-all', () => {
  async function buildServer() {
    const registry = buildRegistry();
    const server = Fastify();
    await server.register(registerHookRoutes({ actionExecutor: buildExecutor(registry) }), {
      prefix: '/hooks',
    });
    return server;
  }

  afterEach(() => undefined);

  it('delivers the raw body bytes and maps the handler result', async () => {
    const server = await buildServer();
    const payload = '{"id": "evt_1",   "spacing-preserved": true}';
    const res = await server.inject({
      method: 'POST',
      url: '/hooks/invoicing/stripe',
      payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=zz' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ bytes: Buffer.byteLength(payload), sig: 't=1,v1=zz' });
  });

  it('accepts non-JSON content types (raw passthrough)', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/hooks/invoicing/stripe',
      payload: 'a=b&c=d',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().bytes).toBe(7);
  });

  it('404s hooks of uninstalled blocks with the flat envelope', async () => {
    const server = await buildServer();
    const res = await server.inject({ method: 'POST', url: '/hooks/nope/stripe', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not Found' });
  });
});
