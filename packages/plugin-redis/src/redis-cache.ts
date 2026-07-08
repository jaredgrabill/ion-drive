/**
 * Redis-backed {@link CacheProvider} — replaces core's in-process MemoryCache
 * for multi-node coherence. Values are JSON-serialized (the port treats them
 * as opaque, so callers must cache JSON-safe values — `undefined` members and
 * class instances degrade the way `JSON.stringify` always does). Keys are
 * namespaced under a prefix (`ion:cache:` by default) so `clear()` can scan
 * and remove exactly this cache's keys without touching the rest of the
 * database.
 */

import type { CacheProvider } from '@ion-drive/core';
import type { RedisApi } from './redis-api.js';

export class RedisCache implements CacheProvider {
  readonly name = 'redis';

  constructor(
    private readonly redis: RedisApi,
    private readonly prefix: string,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined; // foreign/corrupt value — treat as a miss
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.redis.setValue(this.prefix + key, JSON.stringify(value ?? null), ttlMs);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.deleteKeys(this.prefix + key)) > 0;
  }

  async has(key: string): Promise<boolean> {
    return this.redis.exists(this.prefix + key);
  }

  async clear(): Promise<void> {
    const keys = await this.redis.scanKeys(`${this.prefix}*`);
    // Delete in batches — a huge cache shouldn't produce one giant command.
    for (let i = 0; i < keys.length; i += 500) {
      await this.redis.deleteKeys(...keys.slice(i, i + 500));
    }
  }
}
