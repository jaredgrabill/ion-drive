import { describe, expect, it } from 'vitest';
import { CACHE_SERVICE, type CacheProvider } from '../cache/index.js';
import { loadConfig } from '../config/index.js';
import type { LoggerProvider } from '../logging/logger-provider.js';
import type { MessageBus } from '../messaging/message-bus.js';
import { type PluginContext, definePlugin, loadPlugins } from './plugin.js';
import { ServiceRegistry } from './service-registry.js';

/** A silent logger whose `child` returns itself. */
const silentLogger: LoggerProvider = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

/** A no-op bus double (plugins may reference it but these tests do not drive it). */
const fakeBus: MessageBus = {
  publish: async () => {},
  subscribe: () => {},
  on: () => {},
  registerHandler: () => {},
  hasHandler: () => false,
  listSubscriptions: () => [],
  unsubscribeConsumer: () => {},
  wake: () => {},
};

/** A stub cache with a distinguishing name, to prove overrides take effect. */
function stubCache(name: string): CacheProvider {
  return {
    name,
    get: async () => undefined,
    set: async () => {},
    delete: async () => false,
    has: async () => false,
    clear: async () => {},
  };
}

function makeContext(registry = new ServiceRegistry()): PluginContext {
  return { registry, config: loadConfig({}), logger: silentLogger, bus: fakeBus };
}

describe('definePlugin', () => {
  it('returns the plugin unchanged (identity helper)', () => {
    const plugin = definePlugin({ name: 'x', setup: () => {} });
    expect(plugin.name).toBe('x');
  });
});

describe('loadPlugins', () => {
  it('runs setup and lets a plugin override a default service', async () => {
    const registry = new ServiceRegistry();
    registry.set(CACHE_SERVICE, stubCache('memory'));
    const context = makeContext(registry);

    const redis = definePlugin({
      name: 'redis',
      setup(ctx) {
        ctx.registry.set(CACHE_SERVICE, stubCache('redis'));
      },
    });

    await loadPlugins({ plugins: [redis], context });

    expect(registry.require(CACHE_SERVICE).name).toBe('redis');
  });

  it('runs plugin setup in order (later plugins win)', async () => {
    const order: string[] = [];
    const registry = new ServiceRegistry();
    const context = makeContext(registry);

    const a = definePlugin({
      name: 'a',
      setup(ctx) {
        order.push('a');
        ctx.registry.set(CACHE_SERVICE, stubCache('a'));
      },
    });
    const b = definePlugin({
      name: 'b',
      setup(ctx) {
        order.push('b');
        ctx.registry.set(CACHE_SERVICE, stubCache('b'));
      },
    });

    await loadPlugins({ plugins: [a, b], context });

    expect(order).toEqual(['a', 'b']);
    expect(registry.require(CACHE_SERVICE).name).toBe('b');
  });

  it('invokes onShutdown hooks in reverse order', async () => {
    const shutdowns: string[] = [];
    const context = makeContext();
    const a = definePlugin({
      name: 'a',
      setup: () => {},
      onShutdown: () => void shutdowns.push('a'),
    });
    const b = definePlugin({
      name: 'b',
      setup: () => {},
      onShutdown: () => void shutdowns.push('b'),
    });

    const loaded = await loadPlugins({ plugins: [a, b], context });
    await loaded.runShutdown();

    expect(shutdowns).toEqual(['b', 'a']);
  });

  it('propagates an error thrown by a plugin setup', async () => {
    const context = makeContext();
    const boom = definePlugin({
      name: 'boom',
      setup() {
        throw new Error('kaboom');
      },
    });

    await expect(loadPlugins({ plugins: [boom], context })).rejects.toThrow('kaboom');
  });
});
