/**
 * Block installer — materialises a validated manifest into a running instance.
 *
 * Installing a block is deliberately just a *scripted sequence of the same
 * operations a human performs by hand*: create objects through the
 * {@link SchemaManager}, wire relationships, seed rows through the
 * {@link DataService}, register tasks through the {@link TaskEngine}, and seed
 * roles through the {@link RoleManager}. That reuse is the whole point — a block
 * can never do anything the platform's own APIs can't, so the REST/GraphQL/MCP
 * surfaces light up for a block's objects with zero extra wiring.
 *
 * Every step is **idempotent-friendly**: objects/tasks/roles that already exist
 * are skipped (and reported) rather than erroring, so re-running an install or
 * layering blocks that share objects is safe. `dryRun` computes the same report
 * without touching the database, powering the CLI/console preview.
 */

import { createRequire } from 'node:module';
import semver from 'semver';
import type { RoleManager } from '../auth/rbac/role-manager.js';
import type { DataService } from '../data/data-service.js';
import type { MessageBus } from '../messaging/message-bus.js';
import type { WebhookManager } from '../messaging/webhooks.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import type { TaskEngine } from '../tasks/index.js';
import type { ActionRegistry } from './action-registry.js';
import {
  type BlockInstallReport,
  type BlockManifest,
  type InstalledBlock,
  toDataObjectDefinition,
  toRelationshipDefinition,
  toSubscriptionInput,
  toTaskInput,
} from './block-types.js';

/** The core package's own version — the default `coreVersion` (works from src/ and dist/). */
const OWN_CORE_VERSION: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

export class BlockInstallError extends Error {
  constructor(
    message: string,
    readonly warnings: string[] = [],
    /**
     * Machine-readable failure kind. `core_range` (an unsatisfied
     * `requires.core`, spec-02) maps to a 400 validation error in the engine;
     * everything else stays the generic 500 install failure.
     */
    readonly code?: 'core_range',
  ) {
    super(message);
    this.name = 'BlockInstallError';
  }
}

export interface BlockInstallerServices {
  schemaManager: SchemaManager;
  dataService: DataService;
  /** Optional — required only if a manifest declares tasks. */
  taskEngine?: TaskEngine;
  /** Optional — required only if a manifest declares roles. */
  roleManager?: RoleManager;
  /** Optional — required only if a manifest declares subscriptions. */
  bus?: MessageBus;
  /** Optional — required only if a manifest declares actions/hooks (Phase 14). */
  actionRegistry?: ActionRegistry;
  /** Optional — required only if a manifest declares outbound webhooks (Phase 12). */
  webhookManager?: WebhookManager;
  /** Names of plugins loaded through the plugin host, for `requires.plugins` validation. */
  pluginNames?: string[];
  /**
   * The running core version `requires.core` is checked against (spec-02).
   * Defaults to this package's own version; injectable for tests.
   */
  coreVersion?: string;
}

export interface InstallOptions {
  /** Compute the report without writing anything. */
  dryRun?: boolean;
  /** Downgrade `requires.core` failures to warnings (the ADR-017 force contract). */
  force?: boolean;
}

export interface UninstallOptions {
  /** Drop tables even if they contain rows. Without this, a non-empty table blocks uninstall. */
  dropData?: boolean;
}

export class BlockInstaller {
  constructor(private readonly services: BlockInstallerServices) {}

  /**
   * Applies a manifest through five ordered steps (objects → relationships →
   * seed → tasks → roles), returning a report of everything created/skipped. On
   * a real (non-dry) run, throws {@link BlockInstallError} if a step fails.
   */
  async install(
    manifest: BlockManifest,
    options: InstallOptions = {},
  ): Promise<BlockInstallReport> {
    const dryRun = options.dryRun ?? false;
    const report: BlockInstallReport = {
      block: manifest.name,
      version: manifest.version,
      dryRun,
      objectsCreated: [],
      objectsSkipped: [],
      relationshipsCreated: [],
      recordsSeeded: {},
      tasksCreated: [],
      rolesCreated: [],
      rolesSkipped: [],
      subscriptionsRegistered: [],
      actionsExposed: [],
      hooksExposed: [],
      webhooksCreated: {},
      webhooksSkipped: [],
      warnings: [],
    };

    // Requirements first: a block whose vendored code is missing or whose
    // `requires.core` excludes this server must fail (or, in preview, report)
    // before any schema is touched.
    this.checkRequirements(manifest, report, dryRun, options.force ?? false);

    await this.applyObjects(manifest, report, dryRun);
    await this.applyRelationships(manifest, report, dryRun);
    await this.applySeed(manifest, report, dryRun);
    await this.applyTasks(manifest, report, dryRun);
    await this.applyRoles(manifest, report, dryRun);
    this.applySubscriptions(manifest, report, dryRun);
    await this.applyWebhooks(manifest, report, dryRun);

    return report;
  }

  /**
   * Validates the manifest's runtime requirements (Phase 14 + spec-02): the
   * running core version must satisfy `requires.core`, every declared
   * action/hook must have a handler registered by the block's vendored code,
   * every `requires.handlers` entry must be a registered bus handler, and every
   * `requires.plugins` entry must be a loaded plugin. On a real install a
   * missing requirement throws with a "did you vendor its code?" pointer; in
   * preview it becomes a warning so `dryRun` reports the same facts.
   */
  private checkRequirements(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
    force: boolean,
  ): void {
    this.checkCoreRange(manifest, report, dryRun, force);
    const missing = this.collectMissingRequirements(manifest);

    for (const action of manifest.actions) report.actionsExposed.push(action.name);
    for (const hook of manifest.hooks) report.hooksExposed.push(hook.name);

    if (missing.length === 0) return;
    if (dryRun) {
      for (const item of missing) report.warnings.push(`Missing requirement: ${item}`);
      return;
    }
    throw new BlockInstallError(
      `Block "${manifest.name}" requires ${missing.join('; ')} — did you vendor its code? (expected in /blocks/${manifest.name})`,
      report.warnings,
    );
  }

  /**
   * Enforces `requires.core` (spec-02): the running core version must satisfy
   * the manifest's declared range. Dry runs report a warning; `force`
   * downgrades the failure to a warning (the ADR-017 force contract); a real
   * install throws a {@link BlockInstallError} tagged `core_range` so the
   * engine maps it to a 400 validation error, naming both versions.
   */
  private checkCoreRange(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
    force: boolean,
  ): void {
    const range = manifest.requires.core;
    if (!range) return;
    const coreVersion = this.services.coreVersion ?? OWN_CORE_VERSION;
    if (semver.satisfies(coreVersion, range)) return;

    const message = `Block "${manifest.name}" requires core ${range} but this server runs core ${coreVersion}`;
    if (dryRun) {
      report.warnings.push(message);
      return;
    }
    if (force) {
      report.warnings.push(`${message} — overridden by force`);
      return;
    }
    throw new BlockInstallError(message, report.warnings, 'core_range');
  }

  /** Human-readable descriptions of every unmet requirement. */
  private collectMissingRequirements(manifest: BlockManifest): string[] {
    const { actionRegistry, bus, pluginNames } = this.services;
    const missing: string[] = [];
    for (const action of manifest.actions) {
      if (!actionRegistry?.hasAction(manifest.name, action.name)) {
        missing.push(`action handler "${manifest.name}.${action.name}"`);
      }
    }
    for (const hook of manifest.hooks) {
      if (!actionRegistry?.hasHook(manifest.name, hook.name)) {
        missing.push(`hook handler "${manifest.name}.${hook.name}"`);
      }
    }
    for (const handler of manifest.requires.handlers) {
      if (!bus?.hasHandler(handler)) missing.push(`bus handler "${handler}"`);
    }
    const loaded = new Set(pluginNames ?? []);
    for (const plugin of manifest.requires.plugins) {
      if (!loaded.has(plugin)) missing.push(`plugin "${plugin}"`);
    }
    return missing;
  }

  private async applyObjects(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    for (const obj of manifest.objects) {
      if (schemaManager.getObject(obj.name)) {
        report.objectsSkipped.push(obj.name);
        continue;
      }
      report.objectsCreated.push(obj.name);
      if (dryRun) continue;

      const result = await schemaManager.createObject(toDataObjectDefinition(obj, manifest.name));
      if (!result.success) {
        const detail = result.preview.errors.map((e) => e.message).join('; ');
        throw new BlockInstallError(
          `Failed to create object "${obj.name}": ${detail || 'validation failed'}`,
          report.warnings,
        );
      }
    }
  }

  private async applyRelationships(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    for (const rel of manifest.relationships) {
      // Idempotent-friendly like objects/tasks/roles: a relationship with this
      // name already on the source object is skipped (force reinstall path).
      const existing = schemaManager.registry
        .getRelationships(rel.sourceObjectName)
        .some((r) => r.name === rel.name && r.sourceObjectName === rel.sourceObjectName);
      if (existing) {
        report.warnings.push(`Relationship "${rel.name}" already exists — skipped.`);
        continue;
      }
      // Both endpoints must resolve (from this block or an already-installed one).
      const missingEndpoint = this.unresolvedEndpoint(rel, dryRun);
      if (missingEndpoint) {
        report.warnings.push(`Skipped relationship "${rel.name}": missing ${missingEndpoint}`);
        continue;
      }
      report.relationshipsCreated.push(rel.name);
      if (dryRun) continue;

      const result = await schemaManager.addRelationship(
        toRelationshipDefinition(rel, manifest.name),
      );
      if (!result.success) {
        const detail = result.preview.errors.map((e) => e.message).join('; ');
        throw new BlockInstallError(
          `Failed to create relationship "${rel.name}": ${detail || 'validation failed'}`,
          report.warnings,
        );
      }
    }
  }

  /** Returns the name of an unresolved relationship endpoint, or null if both resolve. */
  private unresolvedEndpoint(
    rel: BlockManifest['relationships'][number],
    dryRun: boolean,
  ): string | null {
    const { schemaManager } = this.services;
    if (!schemaManager.getObject(rel.sourceObjectName) && !dryRun) return rel.sourceObjectName;
    if (!schemaManager.getObject(rel.targetObjectName) && !dryRun) return rel.targetObjectName;
    return null;
  }

  private async applySeed(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    for (const [objectName, records] of Object.entries(manifest.seed)) {
      report.recordsSeeded[objectName] = records.length;
      if (dryRun || records.length === 0) continue;
      await this.services.dataService.bulkCreate(objectName, records);
    }
  }

  private async applyTasks(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    if (manifest.tasks.length === 0) return;
    const { taskEngine } = this.services;
    if (!taskEngine) {
      report.warnings.push('Block declares tasks but the task engine is disabled — skipped.');
      return;
    }
    for (const task of manifest.tasks) {
      if (await taskEngine.store.getByName(task.name)) {
        report.warnings.push(`Task "${task.name}" already exists — skipped.`);
        continue;
      }
      report.tasksCreated.push(task.name);
      if (dryRun) continue;
      await taskEngine.create(toTaskInput(task));
    }
  }

  private async applyRoles(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    if (manifest.roles.length === 0) return;
    const { roleManager } = this.services;
    if (!roleManager) {
      report.warnings.push('Block declares roles but RBAC is unavailable — skipped.');
      return;
    }
    for (const role of manifest.roles) {
      if (await roleManager.getByName(role.name)) {
        report.rolesSkipped.push(role.name);
        continue;
      }
      report.rolesCreated.push(role.name);
      if (dryRun) continue;
      await roleManager.create({
        name: role.name,
        description: role.description ?? null,
        permissions: role.permissions.map((p) => ({ resource: p.resource, actions: p.actions })),
      });
    }
  }

  /**
   * Registers the block's event subscriptions on the message bus. Runs after
   * the schema/tasks/roles so the objects a handler may write to already exist.
   * Idempotent: a block's consumers are cleared before (re)subscribing, so a
   * reinstall doesn't accumulate duplicate subscriptions. A subscription naming
   * an unregistered handler is reported and skipped (rather than failing the
   * whole install), mirroring the other steps' idempotent-friendly behaviour.
   */
  private applySubscriptions(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
  ): void {
    if (manifest.subscriptions.length === 0) return;
    const { bus } = this.services;
    if (!bus) {
      report.warnings.push(
        'Block declares subscriptions but the message bus is disabled — skipped.',
      );
      return;
    }

    const valid = manifest.subscriptions.filter((sub) => {
      if (bus.hasHandler(sub.handler)) return true;
      report.warnings.push(
        `Subscription for consumer "${sub.consumer}" references unknown handler "${sub.handler}" — skipped.`,
      );
      return false;
    });
    for (const sub of valid) {
      report.subscriptionsRegistered.push(`${sub.consumer} ← ${sub.event}`);
    }
    if (dryRun) return;

    for (const consumer of new Set(valid.map((s) => s.consumer))) {
      bus.unsubscribeConsumer(consumer);
    }
    for (const sub of valid) {
      bus.subscribe(toSubscriptionInput(sub, manifest.name));
    }
  }

  /**
   * Provisions the block's outbound webhooks (Phase 12 / ADR-019). Idempotent:
   * a webhook whose name already exists is skipped and reported. Freshly
   * created webhooks surface their once-only signing secret in the report —
   * the only time it is ever readable — stamped `block:<name>` so uninstall
   * can remove them.
   */
  private async applyWebhooks(
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    if (manifest.webhooks.length === 0) return;
    const { webhookManager } = this.services;
    if (!webhookManager) {
      report.warnings.push('Block declares webhooks but the event system is disabled — skipped.');
      return;
    }

    for (const webhook of manifest.webhooks) {
      const existing = await webhookManager.getByName(webhook.name);
      if (existing) {
        report.webhooksSkipped.push(webhook.name);
        continue;
      }
      if (dryRun) {
        report.webhooksCreated[webhook.name] = '(generated on install)';
        continue;
      }
      const created = await webhookManager.create({
        name: webhook.name,
        url: webhook.url,
        topics: webhook.topics,
        headers: webhook.headers,
        managedBy: `block:${manifest.name}`,
      });
      report.webhooksCreated[webhook.name] = created.secret;
    }
  }

  /** Removes every subscription a block registered (by consumer group). */
  private unsubscribeBlock(installed: InstalledBlock): void {
    const { bus } = this.services;
    if (!bus) return;
    for (const consumer of new Set(
      (installed.manifest.subscriptions ?? []).map((s) => s.consumer),
    )) {
      bus.unsubscribeConsumer(consumer);
    }
  }

  /**
   * Removes an installed block: unsubscribes its event consumers, deletes the
   * tasks it declared, and drops the objects it created (newest-first so FK
   * dependents go before their targets). Refuses to drop a table that still
   * holds rows unless `dropData` is set.
   */
  async uninstall(installed: InstalledBlock, options: UninstallOptions = {}): Promise<string[]> {
    const { schemaManager, taskEngine, webhookManager } = this.services;
    const dropData = options.dropData ?? false;

    this.unsubscribeBlock(installed);

    // Remove outbound webhooks this block provisioned (by provenance stamp).
    if (webhookManager) {
      await webhookManager.removeByManagedBy(`block:${installed.name}`);
    }

    // Delete tasks this block declared (by name).
    if (taskEngine) {
      for (const task of installed.manifest.tasks ?? []) {
        const existing = await taskEngine.store.getByName(task.name);
        if (existing) await taskEngine.remove(existing.id);
      }
    }

    if (!dropData) await this.assertObjectsEmpty(installed);

    // Drop objects newest-first (reverse creation order handles FK dependents).
    const removed: string[] = [];
    for (const name of [...installed.createdObjects].reverse()) {
      if (!schemaManager.getObject(name)) continue;
      const result = await schemaManager.deleteObject(name);
      if (result.success) removed.push(name);
    }
    return removed;
  }

  /** Throws {@link BlockInstallError} if any of the block's objects hold rows. */
  private async assertObjectsEmpty(installed: InstalledBlock): Promise<void> {
    const { schemaManager, dataService } = this.services;
    const nonEmpty: string[] = [];
    for (const name of installed.createdObjects) {
      if (!schemaManager.getObject(name)) continue;
      const { pagination } = await dataService.list(name, { pagination: { page: 1, pageSize: 1 } });
      if (pagination.totalCount > 0) nonEmpty.push(`${name} (${pagination.totalCount} rows)`);
    }
    if (nonEmpty.length > 0) {
      throw new BlockInstallError(
        `Refusing to uninstall "${installed.name}": these objects hold data — ${nonEmpty.join(', ')}. Re-run with dropData to remove them.`,
      );
    }
  }
}
