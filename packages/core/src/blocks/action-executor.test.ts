/**
 * Unit tests for the Phase 14 action/hook seam: the {@link ActionRegistry}
 * (registration semantics) and the {@link ActionExecutor} (resolution contract,
 * input validation, timeout envelope, hook result mapping).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { IonDriveConfig, SecretsManager } from '../config/index.js';
import type { DataService } from '../data/data-service.js';
import type { LoggerProvider } from '../logging/logger-provider.js';
import { ActionError, ActionExecutor, mcpShapeForAction } from './action-executor.js';
import { ActionRegistry } from './action-registry.js';
import { parseManifest } from './block-manifest.js';
import type { BlockManifest, InstalledBlock } from './block-types.js';

const stubLogger: LoggerProvider = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return stubLogger;
  },
};

/** Builds an installed-block ledger row around a parsed manifest. */
function installed(manifest: BlockManifest): InstalledBlock {
  return {
    name: manifest.name,
    version: manifest.version,
    title: manifest.title,
    status: 'installed',
    createdObjects: [],
    manifest,
    installedAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeExecutor(registry: ActionRegistry, blocks: InstalledBlock[]) {
  const byName = new Map(blocks.map((b) => [b.name, b]));
  return new ActionExecutor({
    registry,
    getInstalledBlock: async (name) => byName.get(name),
    listInstalledBlocks: async () => blocks,
    dataService: {} as DataService,
    secrets: {} as SecretsManager,
    config: {} as IonDriveConfig,
    logger: stubLogger,
  });
}

const invoicingManifest = parseManifest({
  name: 'invoicing',
  title: 'Invoicing',
  actions: [
    { name: 'create_payment_link', description: 'Create a payment link' },
    { name: 'locked_action', rbac: { resource: 'secrets', action: 'manage' } },
  ],
  hooks: [{ name: 'stripe' }],
});

describe('ActionRegistry', () => {
  it('registers and lists actions and hooks per block', () => {
    const registry = new ActionRegistry();
    registry.registerAction({ block: 'a', name: 'x', handler: async () => null });
    registry.registerAction({ block: 'b', name: 'y', handler: async () => null });
    registry.registerHook({ block: 'a', name: 'h', handler: async () => undefined });

    expect(registry.hasAction('a', 'x')).toBe(true);
    expect(registry.hasAction('a', 'y')).toBe(false);
    expect(registry.listActions('a').map((d) => d.name)).toEqual(['x']);
    expect(registry.listActions().length).toBe(2);
    expect(registry.hasHook('a', 'h')).toBe(true);
  });

  it('last write wins on re-registration', () => {
    const registry = new ActionRegistry();
    registry.registerAction({ block: 'a', name: 'x', handler: async () => 'first' });
    registry.registerAction({ block: 'a', name: 'x', handler: async () => 'second' });
    expect(registry.listActions().length).toBe(1);
  });
});

describe('ActionExecutor.resolveAction', () => {
  it('rejects when the block is not installed', async () => {
    const executor = makeExecutor(new ActionRegistry(), []);
    await expect(executor.resolveAction('invoicing', 'create_payment_link')).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('not installed'),
    });
  });

  it('rejects when the action is not declared in the manifest', async () => {
    const registry = new ActionRegistry();
    registry.registerAction({ block: 'invoicing', name: 'undeclared', handler: async () => null });
    const executor = makeExecutor(registry, [installed(invoicingManifest)]);
    await expect(executor.resolveAction('invoicing', 'undeclared')).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('does not declare'),
    });
  });

  it('points at the vendored-code path when declared but unregistered', async () => {
    const executor = makeExecutor(new ActionRegistry(), [installed(invoicingManifest)]);
    await expect(executor.resolveAction('invoicing', 'create_payment_link')).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('/blocks/invoicing'),
    });
  });

  it('applies default RBAC (update on blocks) and manifest overrides', async () => {
    const registry = new ActionRegistry();
    registry.registerAction({
      block: 'invoicing',
      name: 'create_payment_link',
      handler: async () => null,
    });
    registry.registerAction({
      block: 'invoicing',
      name: 'locked_action',
      handler: async () => null,
    });
    const executor = makeExecutor(registry, [installed(invoicingManifest)]);

    const normal = await executor.resolveAction('invoicing', 'create_payment_link');
    expect(normal.rbac).toEqual({ resource: 'blocks', action: 'update' });

    const locked = await executor.resolveAction('invoicing', 'locked_action');
    expect(locked.rbac).toEqual({ resource: 'secrets', action: 'manage' });
  });
});

describe('ActionExecutor.executeAction', () => {
  it('validates input with the registered Zod schema and reports issues', async () => {
    const registry = new ActionRegistry();
    registry.registerAction({
      block: 'invoicing',
      name: 'create_payment_link',
      input: z.object({ invoiceId: z.string().uuid() }),
      handler: async (ctx) => ({ echoed: ctx.input.invoiceId }),
    });
    const executor = makeExecutor(registry, [installed(invoicingManifest)]);
    const { definition } = await executor.resolveAction('invoicing', 'create_payment_link');

    await expect(
      executor.executeAction(definition, { invoiceId: 'nope' }, null),
    ).rejects.toMatchObject({ code: 'validation', issues: [expect.stringContaining('invoiceId')] });

    const id = '7d5c02e2-32e0-4b1c-a83a-111111111111';
    await expect(executor.executeAction(definition, { invoiceId: id }, null)).resolves.toEqual({
      echoed: id,
    });
  });

  it('wraps handler failures as ActionError(failed)', async () => {
    const registry = new ActionRegistry();
    registry.registerAction({
      block: 'invoicing',
      name: 'create_payment_link',
      handler: async () => {
        throw new Error('stripe exploded');
      },
    });
    const executor = makeExecutor(registry, [installed(invoicingManifest)]);
    const { definition } = await executor.resolveAction('invoicing', 'create_payment_link');
    await expect(executor.executeAction(definition, {}, null)).rejects.toMatchObject({
      code: 'failed',
      message: 'stripe exploded',
    });
  });

  it('aborts a hanging handler at its timeout', async () => {
    const registry = new ActionRegistry();
    registry.registerAction({
      block: 'invoicing',
      name: 'create_payment_link',
      timeoutMs: 30,
      handler: () => new Promise(() => {}), // never resolves
    });
    const executor = makeExecutor(registry, [installed(invoicingManifest)]);
    const { definition } = await executor.resolveAction('invoicing', 'create_payment_link');
    await expect(executor.executeAction(definition, {}, null)).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('ActionExecutor.executeHook', () => {
  const delivery = {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=abc' },
    query: {},
    rawBody: Buffer.from('{"hello":true}'),
  };

  it('runs a declared+registered hook and applies response defaults', async () => {
    const registry = new ActionRegistry();
    let seenBody = '';
    registry.registerHook({
      block: 'invoicing',
      name: 'stripe',
      handler: async (ctx) => {
        seenBody = ctx.rawBody.toString('utf8');
        return undefined; // defaults apply
      },
    });
    const executor = makeExecutor(registry, [installed(invoicingManifest)]);
    const result = await executor.executeHook('invoicing', 'stripe', delivery);
    expect(result).toEqual({ status: 200, body: { received: true } });
    expect(seenBody).toBe('{"hello":true}');
  });

  it('lets the handler control status and body (signature rejection)', async () => {
    const registry = new ActionRegistry();
    registry.registerHook({
      block: 'invoicing',
      name: 'stripe',
      handler: async () => ({ status: 400, body: { error: 'bad signature' } }),
    });
    const executor = makeExecutor(registry, [installed(invoicingManifest)]);
    const result = await executor.executeHook('invoicing', 'stripe', delivery);
    expect(result).toEqual({ status: 400, body: { error: 'bad signature' } });
  });

  it('404s an undeclared hook', async () => {
    const executor = makeExecutor(new ActionRegistry(), [installed(invoicingManifest)]);
    await expect(executor.executeHook('invoicing', 'github', delivery)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('listDeclared*', () => {
  it('lists actions and hooks across installed blocks only', async () => {
    const failedBlock = { ...installed(invoicingManifest), status: 'failed' as const };
    const executor = makeExecutor(new ActionRegistry(), [failedBlock]);
    expect(await executor.listDeclaredActions()).toEqual([]);
    expect(await executor.listDeclaredHooks()).toEqual([]);

    const ok = makeExecutor(new ActionRegistry(), [installed(invoicingManifest)]);
    const actions = await ok.listDeclaredActions();
    expect(actions.map((a) => `${a.block}.${a.name}`)).toEqual([
      'invoicing.create_payment_link',
      'invoicing.locked_action',
    ]);
    expect((await ok.listDeclaredHooks()).map((h) => h.hook.name)).toEqual(['stripe']);
  });
});

describe('mcpShapeForAction', () => {
  it('uses a registered ZodObject shape and falls back to an input record', () => {
    const withObject = mcpShapeForAction({
      block: 'a',
      name: 'x',
      input: z.object({ id: z.string() }),
      handler: async () => null,
    });
    expect(Object.keys(withObject)).toEqual(['id']);

    const fallback = mcpShapeForAction(undefined);
    expect(Object.keys(fallback)).toEqual(['input']);
  });
});
