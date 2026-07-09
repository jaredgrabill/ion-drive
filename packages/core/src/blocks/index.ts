/**
 * Block engine (Phase 6) — public facade over the manifest parser, installer,
 * and ledger. {@link BlockEngine} is the single object the server wires in.
 *
 * It bootstraps `_ion_blocks`, validates submitted manifests, enforces the
 * inter-block dependency graph (the shadcn `registryDependencies` invariant),
 * records the install ledger, and exposes preview/install/uninstall. All
 * install flows go through here so the ledger and the live schema never drift.
 *
 * Distribution note: the engine is **content-agnostic**. It installs whatever
 * validated manifest it is handed — a registry artifact resolved by the CLI
 * (the official catalog lives in the separate `jaredgrabill/ion-drive-blocks` repo, ADR-018),
 * a local `block.json`, or a POSTed body. Keeping the catalog out of the engine
 * avoids coupling the runtime to any example content. See ADR-013/ADR-018.
 */

import type { Kysely } from 'kysely';
import semver from 'semver';
import type { RoleManager } from '../auth/rbac/role-manager.js';
import type { DataService } from '../data/data-service.js';
import type { SystemDatabase } from '../db/types.js';
import type { MessageBus } from '../messaging/message-bus.js';
import type { WebhookManager } from '../messaging/webhooks.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import type { TaskEngine } from '../tasks/index.js';
import type { ActionRegistry } from './action-registry.js';
import { BlockInstallError, BlockInstaller } from './block-installer.js';
import { BlockManifestError, parseManifest } from './block-manifest.js';
import { BlockStore, bootstrapBlockTables } from './block-store.js';
import {
  type BlockInstallReport,
  type BlockInstallSource,
  type BlockManifest,
  type InstalledBlock,
  toSubscriptionInput,
} from './block-types.js';
import {
  type OutOfRangeDependency,
  dependencyNames,
  evaluateDependencies,
} from './dependency-check.js';
import { diffManifests } from './manifest-diff.js';

/**
 * Error codes map to HTTP statuses in the block routes: `validation` → 400,
 * `dependency`/`dependency_version` → 422, `not_found` → 404, `conflict` →
 * 409, `not_an_upgrade` → 409, `install` → 500. `dependency_version`
 * (spec-02) is a dependency that *is* installed, but at a version outside the
 * declared semver range. `not_an_upgrade` (spec-07) is an upgrade request
 * whose target version is not strictly newer than the installed one.
 */
export type BlockErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'dependency'
  | 'dependency_version'
  | 'not_an_upgrade'
  | 'install';

export class BlockEngineError extends Error {
  constructor(
    readonly code: BlockErrorCode,
    message: string,
    /** Non-fatal notes gathered during the operation. */
    readonly warnings: string[] = [],
  ) {
    super(message);
    this.name = 'BlockEngineError';
  }
}

export interface BlockEngineServices {
  schemaManager: SchemaManager;
  dataService: DataService;
  taskEngine?: TaskEngine;
  roleManager?: RoleManager;
  /** Message bus — required only for blocks that declare subscriptions. */
  bus?: MessageBus;
  /** Action/hook registry — required only for blocks that declare actions/hooks (Phase 14). */
  actionRegistry?: ActionRegistry;
  /** Webhook manager — required only for blocks that declare outbound webhooks (Phase 12). */
  webhookManager?: WebhookManager;
  /** Names of loaded plugins, for `requires.plugins` validation (Phase 14). */
  pluginNames?: string[];
  /**
   * The running core version, checked against manifests' `requires.core`
   * (spec-02). Defaults to core's own package version; injectable for tests.
   */
  coreVersion?: string;
}

export interface InstallBlockOptions {
  /** Preview only — nothing is written. */
  dryRun?: boolean;
  /** Re-apply even if the block is already installed. */
  force?: boolean;
  /**
   * Client-asserted install provenance (spec-04) recorded in the ledger.
   * Absent for bare-manifest installs — the columns stay null.
   */
  source?: BlockInstallSource;
}

export interface UninstallBlockOptions {
  /** Drop tables even when they hold rows. */
  dropData?: boolean;
}

/** Options for {@link BlockEngine.upgrade} (spec-07). */
export interface UpgradeBlockOptions {
  /** Preview only — report + schema previews, nothing written. */
  dryRun?: boolean;
  /** Apply destructive delta changes instead of skipping/releasing them. */
  force?: boolean;
  /** With `force`: drop removed objects even when they still hold rows. */
  dropData?: boolean;
  /** Client-asserted install provenance (spec-04), replacing the ledger's. */
  source?: BlockInstallSource;
}

export class BlockEngine {
  readonly store: BlockStore;
  /** The action/hook registry vendored block code registers into (Phase 14). */
  readonly actionRegistry?: ActionRegistry;
  private readonly installer: BlockInstaller;
  private readonly bus?: MessageBus;

  constructor(
    private readonly db: Kysely<SystemDatabase>,
    services: BlockEngineServices,
  ) {
    this.store = new BlockStore(db);
    this.installer = new BlockInstaller(services);
    this.bus = services.bus;
    this.actionRegistry = services.actionRegistry;
  }

  /**
   * Creates the block ledger table and re-registers the event subscriptions of
   * already-installed blocks (their durable state lives in `_ion_blocks`; the
   * handler *code* is registered on the bus by the server before this runs).
   * Call once at boot.
   */
  async initialize(): Promise<void> {
    await bootstrapBlockTables(this.db);
    await this.registerInstalledSubscriptions();
  }

  /** Re-subscribes every installed block's declared subscriptions on the bus. */
  private async registerInstalledSubscriptions(): Promise<void> {
    if (!this.bus) return;
    const installed = await this.store.list();
    for (const block of installed) {
      if (block.status !== 'installed') continue;
      for (const sub of block.manifest.subscriptions ?? []) {
        this.bus.subscribe(toSubscriptionInput(sub, block.name));
      }
    }
  }

  // --- Queries ---

  listInstalled(): Promise<InstalledBlock[]> {
    return this.store.list();
  }

  getInstalled(name: string): Promise<InstalledBlock | undefined> {
    return this.store.getByName(name);
  }

  /**
   * Validates a manifest and reports what installing it *would* do, without
   * writing anything. Also flags any missing block dependencies.
   */
  async preview(manifestInput: unknown): Promise<BlockInstallReport> {
    const manifest = this.parse(manifestInput);
    const report = await this.installer.install(manifest, { dryRun: true });
    const { missing, outOfRange } = evaluateDependencies(
      manifest.dependencies,
      await this.store.listInstalledVersions(),
    );
    for (const dep of outOfRange) {
      report.warnings.unshift(
        `Dependency ${dep.name}@${dep.installedVersion} does not satisfy the declared range ${dep.range}.`,
      );
    }
    if (missing.length > 0) {
      report.warnings.unshift(`Requires blocks not yet installed: ${missing.join(', ')}`);
    }
    return report;
  }

  // --- Mutations ---

  /**
   * Installs a block from a validated manifest. Enforces the dependency graph,
   * records the ledger, and marks the row `failed` (for diagnosis) if a schema
   * step throws partway.
   */
  async install(
    manifestInput: unknown,
    options: InstallBlockOptions = {},
  ): Promise<BlockInstallReport> {
    const manifest = this.parse(manifestInput);

    if (options.dryRun) {
      return this.preview(manifestInput);
    }

    // Already installed?
    const existing = await this.store.getByName(manifest.name);
    if (existing && existing.status === 'installed' && !options.force) {
      throw new BlockEngineError(
        'conflict',
        `Block "${manifest.name}" is already installed (v${existing.version}). Use force to reinstall.`,
      );
    }

    const outOfRange = await this.checkDependencies(manifest, options.force ?? false);

    await this.store.begin(manifest, options.source);
    try {
      const report = await this.installer.install(manifest, {
        dryRun: false,
        force: options.force,
      });
      for (const dep of outOfRange) {
        report.warnings.push(
          `Dependency ${dep.name}@${dep.installedVersion} does not satisfy ${dep.range} — overridden by force.`,
        );
      }
      // On a force reinstall the objects already exist (skipped, not created) —
      // keep the prior ledger ownership so uninstall still knows what to drop.
      const owned = [...new Set([...(existing?.createdObjects ?? []), ...report.objectsCreated])];
      await this.store.finish(manifest.name, 'installed', owned);
      return report;
    } catch (err) {
      // Preserve prior ledger ownership on failure (spec-07 resolution): a
      // failed force-reinstall must not orphan the objects the previous
      // install created — uninstall still needs to know what to drop.
      await this.store.finish(manifest.name, 'failed', existing?.createdObjects ?? []);
      throw this.asEngineError(err);
    }
  }

  /**
   * Upgrades an installed block to a strictly newer manifest version
   * (spec-07). A SEPARATE flow from {@link install} — the manifest delta is
   * computed against the ledger's snapshot and applied through the
   * installer's upgrade mode (additive apply / modifying pipeline /
   * destructive gate + released-to-user / runtime re-sync).
   *
   * Version gates: not installed → `not_found` ("use install"); equal
   * version → digest-compared no-op or 409 `not_an_upgrade` (the
   * force-reinstall path already covers same-version-different-content;
   * a `failed` row never no-ops); lower version → 409 with the documented
   * remove-then-add recovery.
   *
   * Failure semantics (AC4): the ledger keeps the PRIOR version + manifest
   * snapshot on a mid-way failure (only the status flips to `failed`), so
   * fixing the cause and re-running the same upgrade recomputes the same
   * delta and the idempotent steps complete the job.
   */
  async upgrade(
    manifestInput: unknown,
    options: UpgradeBlockOptions = {},
  ): Promise<BlockInstallReport> {
    const manifest = this.parse(manifestInput);

    const existing = await this.store.getByName(manifest.name);
    if (!existing) {
      throw new BlockEngineError(
        'not_found',
        `Block "${manifest.name}" is not installed — use a plain install (\`ion-drive add ${manifest.name}\`) instead of an upgrade.`,
      );
    }
    if (existing.status === 'installing') {
      throw new BlockEngineError(
        'conflict',
        `Block "${manifest.name}" has an install in progress — retry once it finishes.`,
      );
    }

    // The ledger snapshot is the diff anchor; a pre-v1 (or corrupted) snapshot
    // cannot be diffed — the documented recovery is uninstall + reinstall.
    let oldManifest: BlockManifest;
    try {
      oldManifest = parseManifest(existing.manifest);
    } catch {
      throw new BlockEngineError(
        'validation',
        `The installed manifest snapshot for "${manifest.name}" is not a valid v1 manifest, so an upgrade delta cannot be computed. Recovery: uninstall (\`ion-drive remove ${manifest.name}\`) and reinstall the new version.`,
      );
    }

    const gate = this.checkUpgradeVersionGate(existing, oldManifest, manifest, options);
    if (gate) return gate; // equal-version no-op report

    const outOfRange = await this.checkDependencies(manifest, options.force ?? false);
    const delta = diffManifests(oldManifest, manifest);
    const installerOptions = {
      force: options.force,
      dropData: options.dropData,
    };

    if (options.dryRun) {
      const report = await this.installer.upgrade(existing, manifest, delta, {
        ...installerOptions,
        dryRun: true,
      });
      for (const dep of outOfRange) {
        report.warnings.push(
          `Dependency ${dep.name}@${dep.installedVersion} does not satisfy ${dep.range} — overridden by force.`,
        );
      }
      return report;
    }

    // Begin-with-old/finish-with-new (AC4): only the STATUS flips to
    // `installing` here — the prior version + manifest snapshot stay in the
    // ledger until the installer succeeds, so a mid-way failure leaves the
    // exact diff anchor a re-run needs (the idempotent steps then finish the
    // partially-applied delta).
    await this.store.setStatus(manifest.name, 'installing');
    try {
      const report = await this.installer.upgrade(existing, manifest, delta, {
        ...installerOptions,
        dryRun: false,
      });
      for (const dep of outOfRange) {
        report.warnings.push(
          `Dependency ${dep.name}@${dep.installedVersion} does not satisfy ${dep.range} — overridden by force.`,
        );
      }
      // Ownership math (spec-07 resolution): prior ownership ∪ newly created,
      // minus objects the delta removed — whether they were dropped (force)
      // or released to the user, they are no longer this block's to drop.
      const owned = [...new Set([...existing.createdObjects, ...report.objectsCreated])].filter(
        (name) => !delta.objects.removed.includes(name),
      );
      await this.store.replaceInstalled(manifest, owned, options.source);
      return report;
    } catch (err) {
      // Prior version/snapshot/ownership are still in the row — mark it
      // failed so the user can fix the cause and re-run the SAME upgrade.
      await this.store.setStatus(manifest.name, 'failed');
      throw this.asEngineError(err);
    }
  }

  /**
   * The equal/lower-version gates. Returns a no-op report for a same-version,
   * same-content re-POST; throws for everything that is not a real upgrade.
   */
  private checkUpgradeVersionGate(
    existing: InstalledBlock,
    oldManifest: BlockManifest,
    manifest: BlockManifest,
    options: UpgradeBlockOptions,
  ): BlockInstallReport | null {
    if (semver.gt(manifest.version, existing.version)) return null;

    if (semver.lt(manifest.version, existing.version)) {
      throw new BlockEngineError(
        'not_an_upgrade',
        `Downgrade from ${existing.version} to ${manifest.version} is not supported — recovery is \`ion-drive remove ${manifest.name}\` then \`ion-drive add ${manifest.name}@${manifest.version}\`.`,
      );
    }

    // A failed row at the requested version must never no-op: the live schema
    // may not match its snapshot (e.g. a failed plain install). Repair is a
    // force reinstall, or an upgrade to a strictly newer version.
    if (existing.status === 'failed') {
      throw new BlockEngineError(
        'conflict',
        `Block "${manifest.name}" is in a failed state at ${existing.version} — repair it with a force reinstall (\`ion-drive add ${manifest.name} --force\`) or upgrade to a newer version.`,
      );
    }

    // Equal version: compare digests when both sides have one; otherwise fall
    // back to the structural delta (empty ⇒ genuinely the same content).
    const clientDigest = options.source?.digest;
    const sameContent =
      clientDigest !== undefined && existing.artifactDigest !== null
        ? clientDigest === existing.artifactDigest
        : !diffManifests(oldManifest, manifest).hasChanges;
    if (sameContent) {
      const report = this.noopUpgradeReport(manifest, existing);
      return report;
    }
    throw new BlockEngineError(
      'not_an_upgrade',
      `Block "${manifest.name}" is already at ${existing.version} but with different content — a same-version change is a force reinstall (\`ion-drive add ${manifest.name} --force\`), not an upgrade.`,
    );
  }

  /** An all-empty report for the equal-version, equal-content no-op (200). */
  private noopUpgradeReport(manifest: BlockManifest, existing: InstalledBlock): BlockInstallReport {
    return {
      block: manifest.name,
      version: manifest.version,
      dryRun: false,
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
      upgraded: { from: existing.version, to: manifest.version },
      warnings: [`Block "${manifest.name}" is already at ${existing.version} — nothing to do.`],
    };
  }

  /** Maps installer failures onto engine error codes (shared install/upgrade). */
  private asEngineError(err: unknown): unknown {
    if (err instanceof BlockInstallError) {
      // An unsatisfied `requires.core` is the caller's manifest being wrong
      // for this server — a validation failure (400), not a broken install.
      // A tripped upgrade data guard mirrors uninstall's conflict (409).
      const code =
        err.code === 'core_range'
          ? 'validation'
          : err.code === 'data_guard'
            ? 'conflict'
            : 'install';
      return new BlockEngineError(code, err.message, err.warnings);
    }
    return err;
  }

  /**
   * Uninstalls a block. Refuses if another installed block depends on it, or
   * (without `dropData`) if any of its objects still hold rows.
   */
  async uninstall(
    name: string,
    options: UninstallBlockOptions = {},
  ): Promise<{ removedObjects: string[] }> {
    const installed = await this.store.getByName(name);
    if (!installed) {
      throw new BlockEngineError('not_found', `Block "${name}" is not installed`);
    }

    const dependents = await this.dependentsOf(name);
    if (dependents.length > 0) {
      throw new BlockEngineError(
        'conflict',
        `Cannot uninstall "${name}": ${dependents.join(', ')} depend${dependents.length > 1 ? '' : 's'} on it. Remove ${dependents.length > 1 ? 'them' : 'it'} first.`,
      );
    }

    try {
      const removedObjects = await this.installer.uninstall(installed, {
        dropData: options.dropData,
      });
      await this.store.delete(name);
      return { removedObjects };
    } catch (err) {
      if (err instanceof BlockInstallError) {
        throw new BlockEngineError('conflict', err.message, err.warnings);
      }
      throw err;
    }
  }

  // --- Helpers ---

  /**
   * The spec-02 dependency preflight: every declared dependency must be
   * installed (missing → 422 `dependency`) at a version satisfying its range
   * (out-of-range → 422 `dependency_version`; `force` downgrades to warnings).
   * Returns the out-of-range list so a forced install can report each override.
   */
  private async checkDependencies(
    manifest: BlockManifest,
    force: boolean,
  ): Promise<OutOfRangeDependency[]> {
    const { missing, outOfRange } = evaluateDependencies(
      manifest.dependencies,
      await this.store.listInstalledVersions(),
    );
    if (missing.length > 0) {
      throw new BlockEngineError(
        'dependency',
        `Block "${manifest.name}" requires: ${missing.join(', ')}. Install ${missing.length > 1 ? 'those blocks' : 'that block'} first.`,
      );
    }
    if (outOfRange.length > 0 && !force) {
      const detail = outOfRange
        .map(
          (d) => `requires ${d.name}@${d.range} but ${d.name}@${d.installedVersion} is installed`,
        )
        .join('; ');
      const names = outOfRange.map((d) => d.name).join(' ');
      throw new BlockEngineError(
        'dependency_version',
        `Block "${manifest.name}" ${detail}. Run \`ion-drive update ${names}\` (or reinstall with force).`,
      );
    }
    return outOfRange;
  }

  private parse(input: unknown) {
    try {
      return parseManifest(input);
    } catch (err) {
      if (err instanceof BlockManifestError) {
        throw new BlockEngineError('validation', err.message, err.issues);
      }
      throw err;
    }
  }

  /**
   * Installed blocks that declare `name` as a dependency (record form,
   * matching namespaced refs by bare name). Legacy array snapshots in pre-v1
   * ledgers count as having no dependencies — the spec-02 clean break.
   */
  private async dependentsOf(name: string): Promise<string[]> {
    const all = await this.store.list();
    return all
      .filter((b) => b.name !== name && manifestDependsOn(b.manifest, name))
      .map((b) => b.name);
  }
}

/** Whether a ledger manifest snapshot declares `name` among its dependencies. */
function manifestDependsOn(manifest: BlockManifest, name: string): boolean {
  const deps: unknown = manifest.dependencies;
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return false;
  return dependencyNames(deps as Record<string, string>).includes(name);
}

export { BlockStore, bootstrapBlockTables } from './block-store.js';
export { BlockInstaller, BlockInstallError } from './block-installer.js';
export type { UpgradeInstallOptions } from './block-installer.js';
export { diffManifests, deepEqual } from './manifest-diff.js';
export type { ManifestDelta, FieldDelta, NamedDelta, DeltaKind } from './manifest-diff.js';
export { BlockManifestError, parseManifest } from './block-manifest.js';
export {
  blockManifestSchema,
  blockNameSchema,
  blockRefSchema,
  codePathIssue,
  installSourceSchema,
  semverRangeSchema,
  semverVersionSchema,
  splitBlockRef,
} from './block-types.js';
export { dependencyNames, evaluateDependencies } from './dependency-check.js';
export type { DependencyEvaluation, OutOfRangeDependency } from './dependency-check.js';
export type {
  BlockManifest,
  BlockManifestInput,
  BlockObject,
  BlockRelationship,
  BlockRole,
  BlockStatus,
  BlockActionDeclaration,
  BlockHookDeclaration,
  BlockCodeFile,
  BlockInstallSource,
  InstalledBlock,
  BlockInstallReport,
  UpgradePreviewEntry,
} from './block-types.js';
export { ActionRegistry, ACTION_REGISTRY } from './action-registry.js';
export type {
  ActionContext,
  ActionDefinition,
  ActionRbac,
  HookContext,
  HookDefinition,
  HookResult,
} from './action-registry.js';
export { ActionExecutor, ActionError, mcpShapeForAction } from './action-executor.js';
export type {
  ActionErrorCode,
  ActionExecutorDeps,
  DeclaredAction,
  HookDelivery,
} from './action-executor.js';

// Block registry protocol v1 (ADR-022 / spec-01)
export {
  registryIndexSchema,
  registryBlockSchema,
  registriesDirectorySchema,
  parseRegistryIndex,
  parseRegistryBlock,
  parseRegistriesDirectory,
  RegistryParseError,
  resolveRegistryUrl,
  isPermittedRegistryUrl,
} from './registry-types.js';
export type {
  RegistryIndex,
  RegistryIndexEntry,
  RegistryBlock,
  RegistryVersionEntry,
  RegistryVersionStatus,
  RegistryAdvisory,
  AdvisorySeverity,
  RegistriesDirectory,
  RegistryDirectoryEntry,
} from './registry-types.js';
