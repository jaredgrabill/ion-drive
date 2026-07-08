/**
 * Unit tests for the plugin entry: service swaps, the bus opt-in gate, and the
 * events-disabled guard — all against the in-memory fake connection.
 */

import {
  CACHE_SERVICE,
  type LoggerProvider,
  MESSAGE_BUS,
  type PluginContext,
  ServiceRegistry,
} from '@ion-drive/core';
import { describe, expect, it } from 'vitest';
import { FakeRedis } from './fake-redis.js';
import { redisPlugin } from './index.js';

const noopLogger: LoggerProvider = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function contextWith(registry: ServiceRegistry, eventsEnabled = true): PluginContext {
  return {
    registry,
    config: { eventsEnabled, eventsPollIntervalMs: 2000 } as PluginContext['config'],
    logger: noopLogger,
    bus: {} as PluginContext['bus'],
    actions: {} as PluginContext['actions'],
  };
}

describe('redisPlugin', () => {
  it('swaps the cache by default and leaves the bus alone', async () => {
    const registry = new ServiceRegistry();
    await redisPlugin({ connection: new FakeRedis() }).setup(contextWith(registry));
    expect(registry.require(CACHE_SERVICE).name).toBe('redis');
    expect(registry.has(MESSAGE_BUS)).toBe(false);
  });

  it('swaps the bus when opted in', async () => {
    const registry = new ServiceRegistry();
    await redisPlugin({ connection: new FakeRedis(), bus: true }).setup(contextWith(registry));
    expect(registry.has(MESSAGE_BUS)).toBe(true);
    expect(registry.require(MESSAGE_BUS).constructor.name).toBe('RedisStreamsBus');
  });

  it('respects cache:false', async () => {
    const registry = new ServiceRegistry();
    await redisPlugin({ connection: new FakeRedis(), cache: false, bus: true }).setup(
      contextWith(registry),
    );
    expect(registry.has(CACHE_SERVICE)).toBe(false);
    expect(registry.has(MESSAGE_BUS)).toBe(true);
  });

  it('refuses the bus swap when events are disabled', async () => {
    const registry = new ServiceRegistry();
    await redisPlugin({ connection: new FakeRedis(), bus: true }).setup(
      contextWith(registry, false),
    );
    expect(registry.has(MESSAGE_BUS)).toBe(false);
  });
});
