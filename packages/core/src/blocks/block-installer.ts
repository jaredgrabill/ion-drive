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
import type { ChangePreview, FieldDefinition, FieldModification } from '../schema/types.js';
import type { TaskEngine } from '../tasks/index.js';
import type { ActionRegistry } from './action-registry.js';
import {
  type BlockInstallReport,
  type BlockManifest,
  type BlockObject,
  type InstalledBlock,
  type UpgradePreviewEntry,
  toDataObjectDefinition,
  toRelationshipDefinition,
  toSubscriptionInput,
  toTaskInput,
} from './block-types.js';
import type { FieldDelta, ManifestDelta } from './manifest-diff.js';

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
     * `data_guard` (an upgrade would drop non-empty objects without
     * `dropData`, spec-07 — mirrors the uninstall guard) maps to a 409;
     * everything else stays the generic 500 install failure.
     */
    readonly code?: 'core_range' | 'data_guard',
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

/** Options for the installer's upgrade mode (spec-07). */
export interface UpgradeInstallOptions {
  /** Compute the report + schema previews without writing anything. */
  dryRun?: boolean;
  /**
   * Apply destructive manifest changes (removed objects/fields/relationships/
   * tasks) instead of skipping/releasing them, and override contract
   * protection on fields this block does not own.
   */
  force?: boolean;
  /** With `force`: drop removed objects even when they still hold rows. */
  dropData?: boolean;
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
    const report = newInstallReport(manifest, dryRun);

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

  // =========================================================================
  // Upgrade mode (spec-07)
  // =========================================================================

  /**
   * Applies an old→new manifest delta to an installed block (spec-07):
   *
   *  1. requirements gate (same as install — handlers/plugins/`requires.core`);
   *  2. **additive** changes through the existing idempotent steps (objects/
   *     fields/relationships/tasks/roles; seed is deliberately NEVER
   *     re-applied — a `seedChanged` delta only warns);
   *  3. **modifying** field changes through the validated `modifyField`
   *     pipeline (self-owned fields carry an internal force for contract
   *     protection only — data-safety errors are never downgraded); modified
   *     tasks update in place, preserving the live `enabled` flag;
   *  4. **destructive** changes are skipped-and-reported by default; items the
   *     block owns are **released to `user` management** (they are the user's
   *     now, ADR-018). With `force` they are removed instead (objects behind
   *     the same non-empty data guard as uninstall, honoring `dropData`);
   *  5. **runtime wiring** (subscriptions/webhooks) re-syncs to the new
   *     manifest ungated — dropped consumers unsubscribe, dropped webhooks are
   *     removed by provenance, changed webhooks update in place (secret
   *     preserved), added ones are created.
   *
   * `dryRun` computes the same report plus schema-engine previews
   * (`report.previews`) without writing anything.
   */
  async upgrade(
    existing: InstalledBlock,
    manifest: BlockManifest,
    delta: ManifestDelta,
    options: UpgradeInstallOptions = {},
  ): Promise<BlockInstallReport> {
    const dryRun = options.dryRun ?? false;
    const force = options.force ?? false;
    const report = newInstallReport(manifest, dryRun);
    report.upgraded = { from: existing.version, to: manifest.version };
    report.delta = delta;
    if (dryRun) report.previews = [];

    this.checkRequirements(manifest, report, dryRun, force);

    // Additive — the install steps already skip-and-report existing items.
    await this.applyObjects(manifest, report, dryRun);
    await this.applyRelationships(manifest, report, dryRun);
    if (delta.seedChanged) {
      report.warnings.push(
        'Seed data changed between versions — seed is never re-applied on upgrade; migrate existing rows manually if needed.',
      );
    }
    await this.applyTasks(manifest, report, dryRun);
    await this.applyRoles(manifest, report, dryRun);

    // Modifying — validated pipeline for fields; in-place updates for tasks.
    await this.applyFieldDeltas(existing, manifest, delta, report, dryRun, force);
    await this.applyTaskModifications(delta, report, dryRun);

    // Destructive (force) or released-to-user (default).
    if (force) {
      await this.applyDestructive(existing, delta, report, dryRun, options.dropData ?? false);
    } else {
      await this.releaseUndeclared(existing, delta, report, dryRun);
    }

    // Runtime wiring re-sync (ungated — not user data).
    this.resyncSubscriptions(existing, manifest, report, dryRun);
    await this.resyncWebhooks(existing, manifest, delta, report, dryRun);

    return report;
  }

  /**
   * Applies the delta's field-level changes: additions via `addField`,
   * modifications via the validated `modifyField` pipeline. A field this
   * block owns (`managedBy: block:<name>`) passes an internal force covering
   * ONLY contract protection — released/user/other-block fields are skipped
   * and reported unless the request itself carries force. Data-safety errors
   * (constraint violations, missing backfill) always stay hard errors.
   */
  private async applyFieldDeltas(
    existing: InstalledBlock,
    manifest: BlockManifest,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
    requestForce: boolean,
  ): Promise<void> {
    for (const fd of delta.fields) {
      if (fd.kind === 'additive') {
        await this.applyFieldAddition(manifest, fd, report, dryRun);
      } else if (fd.kind === 'modifying') {
        await this.applyFieldModification(existing, fd, report, dryRun, requestForce);
      }
      // 'destructive' field deltas are handled by the force/release phases.
    }
  }

  /** Adds one field declared by the new manifest to an existing object. */
  private async applyFieldAddition(
    manifest: BlockManifest,
    fd: FieldDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    const obj = schemaManager.getObject(fd.objectName);
    if (!obj) return; // object is being created by the additive step (dry run)
    if (obj.fields.some((f) => f.name === fd.fieldName)) {
      report.warnings.push(`Field "${fd.objectName}.${fd.fieldName}" already exists — skipped.`);
      return;
    }
    const field = manifestFieldToDefinition(
      fd.after as BlockObject['fields'][number],
      manifest.name,
    );
    if (dryRun) {
      const preview = await schemaManager.previewChanges([
        {
          type: 'add_field',
          objectName: fd.objectName,
          details: field as unknown as Record<string, unknown>,
        },
      ]);
      report.previews?.push(toPreviewEntry(`add field ${fd.objectName}.${fd.fieldName}`, preview));
      return;
    }
    const result = await schemaManager.addField(fd.objectName, field);
    if (!result.success) {
      throw new BlockInstallError(
        `Failed to add field "${fd.objectName}.${fd.fieldName}": ${previewErrors(result.preview)}`,
        report.warnings,
      );
    }
  }

  /** Routes one modified field through `modifyField` (preview-first pipeline). */
  private async applyFieldModification(
    existing: InstalledBlock,
    fd: FieldDelta,
    report: BlockInstallReport,
    dryRun: boolean,
    requestForce: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    const live = schemaManager
      .getObject(fd.objectName)
      ?.fields.find((f) => f.name === fd.fieldName);
    if (!live) {
      report.warnings.push(
        `Field "${fd.objectName}.${fd.fieldName}" changed in the manifest but does not exist on the server — skipped.`,
      );
      return;
    }
    const selfOwned = live.managedBy === `block:${existing.name}`;
    if (!selfOwned && !requestForce && fd.presentationOnly !== true) {
      report.warnings.push(
        `Field "${fd.objectName}.${fd.fieldName}" is managed by "${live.managedBy ?? 'user'}" (not this block) — modification skipped; re-run with force to apply.`,
      );
      return;
    }

    const updates = fieldDeltaToModification(fd);
    const result = await schemaManager.modifyField(fd.objectName, fd.fieldName, updates, {
      dryRun,
      // Internal force: the block is authorized to change its own fields.
      // This only bypasses contract protection — the validator's data-safety
      // errors (CONSTRAINT_VIOLATIONS, REQUIRES_BACKFILL) are unconditional.
      force: selfOwned || requestForce,
    });
    if (dryRun) {
      report.previews?.push(
        toPreviewEntry(`field ${fd.objectName}.${fd.fieldName}`, result.preview),
      );
      return;
    }
    if (result.success) return;

    const backfill = result.preview.errors.find((e) => e.code === 'REQUIRES_BACKFILL');
    if (backfill) {
      // Resolution: backfill comes from the field's defaultValue; without one
      // the step fails actionably and the upgrade is safely re-runnable.
      throw new BlockInstallError(
        `Cannot upgrade field "${fd.objectName}.${fd.fieldName}": ${backfill.message} The manifest declares no defaultValue to backfill from — add one, or fill the NULL rows manually, then re-run the upgrade.`,
        report.warnings,
      );
    }
    throw new BlockInstallError(
      `Failed to modify field "${fd.objectName}.${fd.fieldName}": ${previewErrors(result.preview)}`,
      report.warnings,
    );
  }

  /** Updates changed task definitions in place, preserving the live `enabled`. */
  private async applyTaskModifications(
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const changed = delta.tasks.filter((t) => t.kind === 'modifying');
    if (changed.length === 0) return;
    const { taskEngine } = this.services;
    if (!taskEngine) {
      report.warnings.push(
        'Block task definitions changed but the task engine is disabled — skipped.',
      );
      return;
    }
    for (const t of changed) {
      const live = await taskEngine.store.getByName(t.name);
      if (!live) continue; // just created by the additive step from the new shape
      report.tasksUpdated.push(t.name);
      if (dryRun) continue;
      const { enabled: _preserveLiveFlag, ...patch } = toTaskInput(
        t.after as BlockManifest['tasks'][number],
      );
      await taskEngine.update(live.id, patch);
    }
  }

  /**
   * Force path: applies the delta's destructive changes through the same
   * preview-first machinery as the designer — relationships before objects
   * (junction drops are IF EXISTS-safe and never doubled: removing the
   * relationship row first means the object drop no longer sees it).
   * Only items this block owns are ever removed.
   */
  private async applyDestructive(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
    dropData: boolean,
  ): Promise<void> {
    await this.removeDeclaredFields(existing, delta, report, dryRun);
    await this.removeDeclaredRelationships(existing, delta, report, dryRun);
    await this.removeDeclaredObjects(existing, delta, report, dryRun, dropData);
    await this.removeDeclaredTasks(delta, report, dryRun);
  }

  /** Force-removes fields the new manifest no longer declares (owned only). */
  private async removeDeclaredFields(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    for (const fd of delta.fields) {
      if (fd.kind !== 'destructive') continue;
      const live = schemaManager
        .getObject(fd.objectName)
        ?.fields.find((f) => f.name === fd.fieldName);
      if (!live) continue; // already gone — idempotent re-run
      if (live.managedBy !== `block:${existing.name}`) {
        report.warnings.push(
          `Field "${fd.objectName}.${fd.fieldName}" was dropped from the manifest but is managed by "${live.managedBy ?? 'user'}" — left in place.`,
        );
        continue;
      }
      const result = await schemaManager.removeField(fd.objectName, fd.fieldName, {
        dryRun,
        force: true,
      });
      if (dryRun) {
        report.previews?.push(
          toPreviewEntry(`remove field ${fd.objectName}.${fd.fieldName}`, result.preview),
        );
        continue;
      }
      if (!result.success) {
        throw new BlockInstallError(
          `Failed to remove field "${fd.objectName}.${fd.fieldName}": ${previewErrors(result.preview)}`,
          report.warnings,
        );
      }
      report.warnings.push(
        `Removed field "${fd.objectName}.${fd.fieldName}" (destructive change applied by force).`,
      );
    }
  }

  /** Force-removes relationships the new manifest no longer declares. */
  private async removeDeclaredRelationships(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    for (const key of delta.relationships.removed) {
      const oldRel = (existing.manifest.relationships ?? []).find(
        (r) => `${r.sourceObjectName}.${r.name}` === key,
      );
      if (!oldRel) continue;
      const live = schemaManager
        .getObject(oldRel.sourceObjectName)
        ?.relationships?.find((r) => r.name === oldRel.name);
      if (!live) continue; // already gone — idempotent re-run
      const result = await schemaManager.removeRelationship(oldRel.sourceObjectName, oldRel.name, {
        dryRun,
        force: true,
      });
      if (dryRun) {
        report.previews?.push(toPreviewEntry(`remove relationship ${key}`, result.preview));
        continue;
      }
      if (!result.success) {
        throw new BlockInstallError(
          `Failed to remove relationship "${key}": ${previewErrors(result.preview)}`,
          report.warnings,
        );
      }
      report.warnings.push(`Removed relationship "${key}" (destructive change applied by force).`);
    }
  }

  /** Force-removes objects the new manifest no longer declares (owned only). */
  private async removeDeclaredObjects(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
    dropData: boolean,
  ): Promise<void> {
    const removable = this.collectRemovableObjects(existing, delta, report);
    if (removable.length === 0) return;

    // The uninstall data guard, scoped to the objects being removed.
    if (!dropData) await this.guardRemovedObjectData(existing, removable, report, dryRun);

    for (const name of removable) {
      await this.removeOneObject(name, report, dryRun);
    }
  }

  /** Removed-object candidates that exist AND were created by this block. */
  private collectRemovableObjects(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
  ): string[] {
    const { schemaManager } = this.services;
    const owned = new Set(existing.createdObjects);
    const removable: string[] = [];
    for (const name of delta.objects.removed) {
      if (!schemaManager.getObject(name)) continue; // already gone
      if (!owned.has(name)) {
        report.warnings.push(
          `Object "${name}" was dropped from the manifest but was not created by this block — left in place.`,
        );
        continue;
      }
      removable.push(name);
    }
    return removable;
  }

  /** Non-empty removed objects → warning (dry run) or `data_guard` error. */
  private async guardRemovedObjectData(
    existing: InstalledBlock,
    removable: string[],
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const nonEmpty = await this.nonEmptyObjects(removable);
    if (nonEmpty.length === 0) return;
    const message = `Refusing to remove objects during upgrade of "${existing.name}": these hold data — ${nonEmpty.join(', ')}. Re-run with dropData to remove them.`;
    if (dryRun) {
      report.warnings.push(message);
      return;
    }
    throw new BlockInstallError(message, report.warnings, 'data_guard');
  }

  /** Previews (dry run) or executes one removed object's drop. */
  private async removeOneObject(
    name: string,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    if (dryRun) {
      const preview = await schemaManager.previewChanges([
        { type: 'delete_object', objectName: name, details: {} },
      ]);
      report.previews?.push(toPreviewEntry(`remove object ${name}`, preview));
      return;
    }
    const result = await schemaManager.deleteObject(name);
    if (!result.success) {
      throw new BlockInstallError(
        `Failed to remove object "${name}": ${previewErrors(result.preview)}`,
        report.warnings,
      );
    }
    report.warnings.push(`Removed object "${name}" (destructive change applied by force).`);
  }

  /** Force-removes tasks the new manifest no longer declares. */
  private async removeDeclaredTasks(
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const removed = delta.tasks.filter((t) => t.kind === 'destructive');
    if (removed.length === 0) return;
    const { taskEngine } = this.services;
    if (!taskEngine) {
      report.warnings.push('Block tasks were dropped but the task engine is disabled — skipped.');
      return;
    }
    for (const t of removed) {
      const live = await taskEngine.store.getByName(t.name);
      if (!live) continue; // already gone — idempotent re-run
      report.tasksRemoved.push(t.name);
      if (dryRun) continue;
      await taskEngine.remove(live.id);
    }
  }

  /**
   * Default (no-force) path for destructive deltas: everything is skipped and
   * reported; items this block owns flip to `user` management — they are the
   * user's now, like vendored code (ADR-018). Removed FK-backed relationships
   * release their FK field (relationships carry no provenance of their own);
   * many_to_many releases are report-only (the junction table stays).
   */
  private async releaseUndeclared(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    await this.releaseUndeclaredObjects(existing, delta, report, dryRun);
    await this.releaseUndeclaredFields(existing, delta, report, dryRun);
    await this.releaseUndeclaredRelationships(existing, delta, report, dryRun);

    for (const t of delta.tasks) {
      if (t.kind === 'destructive') {
        report.skippedDestructive.push(`task "${t.name}" (removed in ${delta.to})`);
      }
    }
  }

  /** Skip-and-release for objects the new manifest no longer declares. */
  private async releaseUndeclaredObjects(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    for (const name of delta.objects.removed) {
      const obj = schemaManager.getObject(name);
      if (!obj) continue;
      report.skippedDestructive.push(`object "${name}" (removed in ${delta.to})`);
      if (obj.managedBy !== `block:${existing.name}`) continue;
      report.released.push(`object "${name}"`);
      if (!dryRun) await schemaManager.releaseToUser(name);
    }
  }

  /** Skip-and-release for fields the new manifest no longer declares. */
  private async releaseUndeclaredFields(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    for (const fd of delta.fields) {
      if (fd.kind !== 'destructive') continue;
      const live = schemaManager
        .getObject(fd.objectName)
        ?.fields.find((f) => f.name === fd.fieldName);
      if (!live) continue;
      report.skippedDestructive.push(
        `field "${fd.objectName}.${fd.fieldName}" (removed in ${delta.to})`,
      );
      if (live.managedBy !== `block:${existing.name}`) continue;
      report.released.push(`field "${fd.objectName}.${fd.fieldName}"`);
      if (!dryRun) await schemaManager.releaseToUser(fd.objectName, fd.fieldName);
    }
  }

  /** Releases the FK fields of removed FK-backed relationships (no force). */
  private async releaseUndeclaredRelationships(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { schemaManager } = this.services;
    for (const key of delta.relationships.removed) {
      const oldRel = (existing.manifest.relationships ?? []).find(
        (r) => `${r.sourceObjectName}.${r.name}` === key,
      );
      if (!oldRel) continue;
      report.skippedDestructive.push(`relationship "${key}" (removed in ${delta.to})`);
      if (oldRel.type === 'many_to_many') {
        // m2m relationships stamp no field — release is report-only.
        report.warnings.push(
          `Relationship "${key}" is many_to_many — the junction table stays; remove it via the schema API if unwanted.`,
        );
        continue;
      }
      const fkObject =
        oldRel.type === 'one_to_many' ? oldRel.targetObjectName : oldRel.sourceObjectName;
      // KEEP IN SYNC with SchemaManager.createRelationshipFkColumn, which
      // names the FK column `${relationship.name}_id` on the "many" side
      // (target for one_to_many, source otherwise). If that naming ever
      // changes, this lookup must change too — otherwise releases silently
      // skip the FK field and leave it under stale block provenance.
      const fkField = `${oldRel.name}_id`;
      const live = schemaManager.getObject(fkObject)?.fields.find((f) => f.name === fkField);
      if (live?.managedBy !== `block:${existing.name}`) continue;
      report.released.push(`field "${fkObject}.${fkField}" (relationship "${key}")`);
      if (!dryRun) await schemaManager.releaseToUser(fkObject, fkField);
    }
  }

  /**
   * Re-syncs bus subscriptions to the new manifest: consumers the old
   * manifest declared but the new one dropped unsubscribe, then the standard
   * idempotent step (re)registers the new manifest's subscriptions.
   */
  private resyncSubscriptions(
    existing: InstalledBlock,
    manifest: BlockManifest,
    report: BlockInstallReport,
    dryRun: boolean,
  ): void {
    const oldSubs = existing.manifest.subscriptions ?? [];
    const { bus } = this.services;
    if (bus && !dryRun) {
      const newConsumers = new Set(manifest.subscriptions.map((s) => s.consumer));
      for (const consumer of new Set(oldSubs.map((s) => s.consumer))) {
        if (!newConsumers.has(consumer)) bus.unsubscribeConsumer(consumer);
      }
    }
    this.applySubscriptions(manifest, report, dryRun);
  }

  /**
   * Re-syncs outbound webhooks to the new manifest (runtime wiring, ungated):
   * dropped names are removed **by provenance** (a user's same-named webhook
   * is never touched), same-name-changed definitions update in place with the
   * signing secret preserved, and added ones are created by the standard
   * idempotent step (their once-only secrets land in the report).
   */
  private async resyncWebhooks(
    existing: InstalledBlock,
    manifest: BlockManifest,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const oldHooks = existing.manifest.webhooks ?? [];
    if (oldHooks.length === 0 && manifest.webhooks.length === 0) return;
    const { webhookManager } = this.services;
    if (!webhookManager) {
      report.warnings.push('Block declares webhooks but the event system is disabled — skipped.');
      return;
    }
    await this.removeDroppedWebhooks(existing, delta, report, dryRun);
    await this.updateChangedWebhooks(existing, manifest, delta, report, dryRun);

    await this.applyWebhooks(manifest, report, dryRun);
    // The idempotent create step "skips" hooks we just updated — dedupe.
    report.webhooksSkipped = report.webhooksSkipped.filter(
      (name) => !report.webhooksUpdated.includes(name),
    );
  }

  /** Removes dropped webhook names — only when this block owns them. */
  private async removeDroppedWebhooks(
    existing: InstalledBlock,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { webhookManager } = this.services;
    if (!webhookManager) return;
    for (const name of delta.webhooks.removed) {
      const view = await webhookManager.getByName(name);
      if (!view) continue;
      if (view.managedBy !== `block:${existing.name}`) {
        report.warnings.push(
          `Webhook "${name}" was dropped from the manifest but is not managed by this block — left in place.`,
        );
        continue;
      }
      report.webhooksRemoved.push(name);
      if (!dryRun) await webhookManager.remove(view.id);
    }
  }

  /** Updates changed webhook definitions in place (signing secret preserved). */
  private async updateChangedWebhooks(
    existing: InstalledBlock,
    manifest: BlockManifest,
    delta: ManifestDelta,
    report: BlockInstallReport,
    dryRun: boolean,
  ): Promise<void> {
    const { webhookManager } = this.services;
    if (!webhookManager) return;
    for (const name of delta.webhooks.changed) {
      const view = await webhookManager.getByName(name);
      const def = manifest.webhooks.find((w) => w.name === name);
      if (!view || !def) continue;
      if (view.managedBy !== `block:${existing.name}`) {
        report.warnings.push(
          `Webhook "${name}" changed in the manifest but is not managed by this block — left in place.`,
        );
        continue;
      }
      report.webhooksUpdated.push(name);
      if (!dryRun) {
        await webhookManager.update(view.id, {
          url: def.url,
          topics: def.topics,
          headers: def.headers,
        });
      }
    }
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
    const nonEmpty = await this.nonEmptyObjects(installed.createdObjects);
    if (nonEmpty.length > 0) {
      throw new BlockInstallError(
        `Refusing to uninstall "${installed.name}": these objects hold data — ${nonEmpty.join(', ')}. Re-run with dropData to remove them.`,
      );
    }
  }

  /** `name (N rows)` for each named object that still holds data. */
  private async nonEmptyObjects(names: string[]): Promise<string[]> {
    const { schemaManager, dataService } = this.services;
    const nonEmpty: string[] = [];
    for (const name of names) {
      if (!schemaManager.getObject(name)) continue;
      const { pagination } = await dataService.list(name, { pagination: { page: 1, pageSize: 1 } });
      if (pagination.totalCount > 0) nonEmpty.push(`${name} (${pagination.totalCount} rows)`);
    }
    return nonEmpty;
  }
}

// ---------------------------------------------------------------------------
// Module helpers (shared by install + upgrade)
// ---------------------------------------------------------------------------

/** A fresh, all-empty install report. */
function newInstallReport(manifest: BlockManifest, dryRun: boolean): BlockInstallReport {
  return {
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
    released: [],
    skippedDestructive: [],
    tasksUpdated: [],
    tasksRemoved: [],
    webhooksUpdated: [],
    webhooksRemoved: [],
    warnings: [],
  };
}

/** Flattens a schema ChangePreview into the wire-friendly report entry. */
function toPreviewEntry(target: string, preview: ChangePreview): UpgradePreviewEntry {
  return {
    target,
    sqlStatements: preview.sqlStatements,
    warnings: preview.warnings.map((w) => w.message),
    errors: preview.errors.map((e) => e.message),
  };
}

/** `; `-joined preview error messages (or a generic fallback). */
function previewErrors(preview: ChangePreview): string {
  return preview.errors.map((e) => e.message).join('; ') || 'validation failed';
}

/** One manifest field → a schema FieldDefinition stamped with block provenance. */
function manifestFieldToDefinition(
  field: BlockObject['fields'][number],
  blockName: string,
): FieldDefinition {
  return {
    name: field.name,
    displayName: field.displayName,
    columnName: field.name,
    columnType: field.columnType,
    isRequired: field.isRequired,
    isUnique: field.isUnique,
    isIndexed: field.isIndexed,
    defaultValue: field.defaultValue ?? undefined,
    constraints: field.constraints,
    sortOrder: field.sortOrder,
    description: field.description,
    uiOptions: field.uiOptions,
    managedBy: `block:${blockName}`,
  };
}

/**
 * Builds the `modifyField` update from a modifying FieldDelta — only the keys
 * the delta says changed, so unrelated properties are never touched. When the
 * change turns `isRequired` on, the field's own `defaultValue` doubles as the
 * backfill for existing NULL rows (spec-07 resolution); without one the
 * validator's REQUIRES_BACKFILL error surfaces actionably.
 */
function fieldDeltaToModification(fd: FieldDelta): FieldModification {
  const after = (fd.after ?? {}) as Partial<BlockObject['fields'][number]>;
  const updates: FieldModification = {};
  for (const key of fd.changedKeys ?? []) {
    applyModificationKey(updates, key, after);
  }
  if (updates.isRequired === true && typeof after.defaultValue === 'string') {
    updates.backfillValue = after.defaultValue;
  }
  return updates;
}

/** Copies one changed manifest key onto the FieldModification. */
function applyModificationKey(
  updates: FieldModification,
  key: string,
  after: Partial<BlockObject['fields'][number]>,
): void {
  switch (key) {
    case 'columnType':
      if (after.columnType !== undefined) updates.columnType = after.columnType;
      break;
    case 'isRequired':
      updates.isRequired = after.isRequired ?? false;
      break;
    case 'isUnique':
      updates.isUnique = after.isUnique ?? false;
      break;
    case 'defaultValue':
      updates.defaultValue = after.defaultValue ?? null;
      break;
    case 'constraints':
      updates.constraints = after.constraints ?? null;
      break;
    case 'displayName':
      if (after.displayName !== undefined) updates.displayName = after.displayName;
      break;
    case 'description':
      updates.description = after.description ?? null;
      break;
    case 'uiOptions':
      updates.uiOptions = (after.uiOptions as FieldModification['uiOptions']) ?? null;
      break;
    case 'isIndexed':
      updates.isIndexed = after.isIndexed ?? false;
      break;
    case 'sortOrder':
      updates.sortOrder = after.sortOrder ?? 0;
      break;
    default:
      break;
  }
}
