/**
 * Runtime module barrel — the service registry and plugin host that together
 * form Ion Drive's extensibility seam (see ADR-015).
 */

export {
  ServiceRegistry,
  ServiceRegistryError,
  serviceToken,
} from './service-registry.js';
export type { ServiceToken } from './service-registry.js';

export { definePlugin, loadPlugins, PluginLoadError } from './plugin.js';
export type {
  IonPlugin,
  PluginContext,
  LoadPluginsOptions,
  LoadedPlugins,
} from './plugin.js';
