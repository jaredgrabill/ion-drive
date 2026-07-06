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
 * (the official catalog lives in the separate `ionshift/blocks` repo, ADR-018),
 * a local `block.json`, or a POSTed body. Keeping the catalog out of the engine
 * avoids coupling the runtime to any example content. See ADR-013/ADR-018.
 */

import type { Kysely } from 'kysely';
import type { RoleManager } from '../auth/rbac/role-manager.js';
import type { DataService } from '../data/data-service.js';
import type { SystemDatabase } from '../db/types.js';
import type { MessageBus } from '../messaging/message-bus.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import type { TaskEngine } from '../tasks/index.js';
import type { ActionRegistry } from './action-registry.js';
import { BlockInstallError, BlockInstaller } from './block-installer.js';
import { BlockManifestError, parseManifest } from './block-manifest.js';
import { BlockStore, bootstrapBlockTables } from './block-store.js';
import {
  type BlockInstallReport,
  type InstalledBlock,
  toSubscriptionInput,
} from './block-types.js';

/** Error codes map to HTTP statuses in the block routes. */
export type BlockErrorCode = 'validation' | 'not_found' | 'conflict' | 'dependency' | 'install';

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
  /** Names of loaded plugins, for `requires.plugins` validation (Phase 14). */
  pluginNames?: string[];
}

export interface InstallBlockOptions {
  /** Preview only — nothing is written. */
  dryRun?: boolean;
  /** Re-apply even if the block is already installed. */
  force?: boolean;
}

export interface UninstallBlockOptions {
  /** Drop tables even when they hold rows. */
  dropData?: boolean;
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
    const missing = await this.missingDependencies(manifest.dependencies);
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

    // Dependencies must be installed first.
    const missing = await this.missingDependencies(manifest.dependencies);
    if (missing.length > 0) {
      throw new BlockEngineError(
        'dependency',
        `Block "${manifest.name}" requires: ${missing.join(', ')}. Install ${missing.length > 1 ? 'those blocks' : 'that block'} first.`,
      );
    }

    await this.store.begin(manifest);
    try {
      const report = await this.installer.install(manifest, { dryRun: false });
      await this.store.finish(manifest.name, 'installed', report.objectsCreated);
      return report;
    } catch (err) {
      await this.store.finish(manifest.name, 'failed', []);
      if (err instanceof BlockInstallError) {
        throw new BlockEngineError('install', err.message, err.warnings);
      }
      throw err;
    }
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

  /** Dependency names not yet fully installed. */
  private async missingDependencies(deps: string[]): Promise<string[]> {
    if (deps.length === 0) return [];
    const installed = await this.store.listInstalledNames();
    return deps.filter((d) => !installed.has(d));
  }

  /** Installed blocks that declare `name` as a dependency. */
  private async dependentsOf(name: string): Promise<string[]> {
    const all = await this.store.list();
    return all
      .filter((b) => b.name !== name && (b.manifest.dependencies ?? []).includes(name))
      .map((b) => b.name);
  }
}

export { BlockStore, bootstrapBlockTables } from './block-store.js';
export { BlockInstaller, BlockInstallError } from './block-installer.js';
export { BlockManifestError, parseManifest } from './block-manifest.js';
export { blockManifestSchema } from './block-types.js';
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
  InstalledBlock,
  BlockInstallReport,
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
