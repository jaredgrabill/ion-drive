/**
 * Plugin host — loads plugins and lets them extend/replace core services.
 *
 * A plugin is a small object (`{ name, setup(ctx), onReady?, onShutdown? }`)
 * shipped as its own npm package. During server assembly, after core registers
 * its default services, each plugin's `setup` runs and may:
 *  - swap an infrastructure service via `ctx.registry.set(TOKEN, impl)` (e.g. a
 *    Redis plugin replacing the cache/bus),
 *  - subscribe to events or register bus handlers via `ctx.bus`.
 *
 * Plugins are resolved from an explicit list — programmatic (`createServer({
 * plugins })`) plus the `ION_PLUGINS` env var (comma-separated module
 * specifiers, dynamically imported). Explicit-over-magic: nothing is discovered
 * by scanning. Later entries win, so an in-code plugin can override an env one.
 * See ADR-015.
 */

import type { IonDriveConfig } from '../config/index.js';
import type { LoggerProvider } from '../logging/logger-provider.js';
import type { MessageBus } from '../messaging/message-bus.js';
import type { ServiceRegistry } from './service-registry.js';

/** The capabilities handed to a plugin's lifecycle hooks. */
export interface PluginContext {
  /** Swap or read infrastructure services (cache, email, bus, logger, …). */
  registry: ServiceRegistry;
  /** The validated server configuration. */
  config: IonDriveConfig;
  /** The platform logger, tagged with the plugin's name. */
  logger: LoggerProvider;
  /** The message bus — subscribe to events or register handlers. */
  bus: MessageBus;
}

/** A pluggable extension to the Ion Drive runtime. */
export interface IonPlugin {
  /** Unique plugin name (used in logs and to tag the plugin's logger). */
  readonly name: string;
  /** Runs during assembly, after defaults are registered and before dependents are built. */
  setup(ctx: PluginContext): void | Promise<void>;
  /** Runs once the server is fully assembled (routes registered). */
  onReady?(ctx: PluginContext): void | Promise<void>;
  /** Runs during graceful shutdown to release resources. */
  onShutdown?(): void | Promise<void>;
}

/** Identity helper giving authoring-time type-checking (mirrors `defineConfig` tools). */
export function definePlugin(plugin: IonPlugin): IonPlugin {
  return plugin;
}

/** Thrown when a plugin module cannot be resolved or is malformed. */
export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginLoadError';
  }
}

export interface LoadPluginsOptions {
  /** Plugins passed programmatically to `createServer`. */
  plugins?: IonPlugin[];
  /** Module specifiers (from `ION_PLUGINS`) to dynamically import. */
  specifiers?: string[];
  /** The shared context handed to every plugin. */
  context: PluginContext;
}

/** The resolved plugins plus deferred lifecycle runners. */
export interface LoadedPlugins {
  plugins: IonPlugin[];
  /** Invokes every plugin's `onReady` (after routes are wired). */
  runReady(): Promise<void>;
  /** Invokes every plugin's `onShutdown` (reverse order) during shutdown. */
  runShutdown(): Promise<void>;
}

/**
 * Resolves and initializes plugins. Specifiers are imported first, then the
 * programmatic list is appended; each plugin's `setup` runs sequentially in
 * that order so later plugins can override earlier ones deterministically.
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadedPlugins> {
  const { context } = options;
  const resolved: IonPlugin[] = [];

  for (const specifier of options.specifiers ?? []) {
    resolved.push(await importPlugin(specifier));
  }
  resolved.push(...(options.plugins ?? []));

  for (const plugin of resolved) {
    const pluginContext: PluginContext = {
      ...context,
      logger: context.logger.child({ plugin: plugin.name }),
    };
    context.logger.info(`Loading plugin "${plugin.name}"`);
    await plugin.setup(pluginContext);
  }

  return {
    plugins: resolved,
    async runReady() {
      for (const plugin of resolved) {
        if (plugin.onReady) {
          await plugin.onReady({
            ...context,
            logger: context.logger.child({ plugin: plugin.name }),
          });
        }
      }
    },
    async runShutdown() {
      // Reverse order so teardown mirrors setup.
      for (const plugin of [...resolved].reverse()) {
        if (plugin.onShutdown) {
          try {
            await plugin.onShutdown();
          } catch (err) {
            context.logger.error(`Plugin "${plugin.name}" onShutdown failed`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    },
  };
}

/** Dynamically imports a plugin module and validates its default export. */
async function importPlugin(specifier: string): Promise<IonPlugin> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    throw new PluginLoadError(
      `Failed to import plugin "${specifier}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const candidate = mod.default ?? mod.plugin;
  if (!isPlugin(candidate)) {
    throw new PluginLoadError(
      `Module "${specifier}" does not export a valid plugin (expected a default export with { name, setup }).`,
    );
  }
  return candidate;
}

/** Structural guard for an {@link IonPlugin}. */
function isPlugin(value: unknown): value is IonPlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IonPlugin).name === 'string' &&
    typeof (value as IonPlugin).setup === 'function'
  );
}
