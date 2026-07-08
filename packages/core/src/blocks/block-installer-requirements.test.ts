/**
 * Unit tests for the installer's requirements gate: declared actions/hooks
 * must have registered handlers, `requires.handlers` must be registered bus
 * handlers, and `requires.plugins` must be loaded plugins (Phase 14) — hard
 * errors on install, warnings in preview. Plus the spec-02 `requires.core`
 * matrix: satisfied / unsatisfied / force-overridden / dry-run against an
 * injected `coreVersion`.
 */

import { describe, expect, it } from 'vitest';
import type { DataService } from '../data/data-service.js';
import type { MessageBus } from '../messaging/message-bus.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import { ActionRegistry } from './action-registry.js';
import { BlockInstallError, BlockInstaller } from './block-installer.js';
import { parseManifest } from './block-manifest.js';

const schemaManager = {
  getObject: () => undefined,
  registry: { getRelationships: () => [] },
} as unknown as SchemaManager;
const dataService = {} as DataService;
const bus = { hasHandler: (name: string) => name === 'log_event' } as unknown as MessageBus;

const manifest = parseManifest({
  name: 'invoicing',
  title: 'Invoicing',
  actions: [{ name: 'create_payment_link' }],
  hooks: [{ name: 'stripe' }],
  requires: { handlers: ['log_event', 'custom_handler'], plugins: ['invoicing'] },
});

describe('BlockInstaller requirements gate', () => {
  it('fails a real install with an actionable message naming the vendored path', async () => {
    const installer = new BlockInstaller({
      schemaManager,
      dataService,
      bus,
      actionRegistry: new ActionRegistry(),
      pluginNames: [],
    });
    await expect(installer.install(manifest, { dryRun: false })).rejects.toThrowError(
      BlockInstallError,
    );
    await expect(installer.install(manifest, { dryRun: false })).rejects.toThrowError(
      /did you vendor its code\? \(expected in \/blocks\/invoicing\)/,
    );
  });

  it('reports every missing requirement as a warning in preview', async () => {
    const installer = new BlockInstaller({
      schemaManager,
      dataService,
      bus,
      actionRegistry: new ActionRegistry(),
      pluginNames: [],
    });
    const report = await installer.install(manifest, { dryRun: true });
    expect(report.warnings).toEqual([
      'Missing requirement: action handler "invoicing.create_payment_link"',
      'Missing requirement: hook handler "invoicing.stripe"',
      'Missing requirement: bus handler "custom_handler"',
      'Missing requirement: plugin "invoicing"',
    ]);
    expect(report.actionsExposed).toEqual(['create_payment_link']);
    expect(report.hooksExposed).toEqual(['stripe']);
  });

  it('passes once handlers, bus handlers, and plugins are all present', async () => {
    const registry = new ActionRegistry();
    registry.registerAction({
      block: 'invoicing',
      name: 'create_payment_link',
      handler: async () => null,
    });
    registry.registerHook({ block: 'invoicing', name: 'stripe', handler: async () => undefined });
    const fullBus = { hasHandler: () => true } as unknown as MessageBus;
    const installer = new BlockInstaller({
      schemaManager,
      dataService,
      bus: fullBus,
      actionRegistry: registry,
      pluginNames: ['invoicing'],
    });
    const report = await installer.install(manifest, { dryRun: false });
    expect(report.warnings).toEqual([]);
    expect(report.actionsExposed).toEqual(['create_payment_link']);
  });

  it('is a no-op for manifests without actions/hooks/requires', async () => {
    const plain = parseManifest({ name: 'crm', title: 'CRM' });
    const installer = new BlockInstaller({ schemaManager, dataService });
    const report = await installer.install(plain, { dryRun: false });
    expect(report.warnings).toEqual([]);
  });
});

describe('BlockInstaller requires.core gate (spec-02)', () => {
  const withCoreRange = (range: string) =>
    parseManifest({ name: 'crm', title: 'CRM', requires: { core: range } });
  const installer = new BlockInstaller({ schemaManager, dataService, coreVersion: '0.3.0' });

  it('passes silently when the running core satisfies the range', async () => {
    const report = await installer.install(withCoreRange('>=0.2.0 <1.0.0'), { dryRun: false });
    expect(report.warnings).toEqual([]);
  });

  it('throws a core_range error naming both versions on a real install', async () => {
    const promise = installer.install(withCoreRange('>=1.0.0'), { dryRun: false });
    await expect(promise).rejects.toThrowError(BlockInstallError);
    await expect(
      installer.install(withCoreRange('>=1.0.0'), { dryRun: false }),
    ).rejects.toThrowError(/requires core >=1\.0\.0 but this server runs core 0\.3\.0/);
    await expect(
      installer.install(withCoreRange('>=1.0.0'), { dryRun: false }),
    ).rejects.toMatchObject({ code: 'core_range' });
  });

  it('force downgrades the failure to a warning and installs', async () => {
    const report = await installer.install(withCoreRange('>=1.0.0'), {
      dryRun: false,
      force: true,
    });
    expect(report.warnings).toEqual([
      'Block "crm" requires core >=1.0.0 but this server runs core 0.3.0 — overridden by force',
    ]);
  });

  it('dry run reports the failure as a warning without throwing', async () => {
    const report = await installer.install(withCoreRange('>=1.0.0'), { dryRun: true });
    expect(report.warnings).toEqual([
      'Block "crm" requires core >=1.0.0 but this server runs core 0.3.0',
    ]);
  });

  it('is a no-op when requires.core is absent', async () => {
    const report = await installer.install(parseManifest({ name: 'crm', title: 'CRM' }), {
      dryRun: false,
    });
    expect(report.warnings).toEqual([]);
  });
});
