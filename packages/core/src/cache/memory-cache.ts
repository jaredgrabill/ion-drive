/**
 * In-process cache — the default {@link CacheProvider}.
 *
 * A `Map`-backed store with lazy TTL expiry: entries carry an absolute expiry
 * timestamp and are evicted on access once elapsed, so no background timer is
 * needed. Suitable for single-node deployments; a Redis plugin replaces it for
 * multi-node coherence. Values are stored by reference (not cloned) — treat
 * cached objects as immutable.
 */

import type { CacheProvider } from './cache-provider.js';

interface Entry {
  value: unknown;
  /** Absolute expiry in epoch ms, or `undefined` for no expiry. */
  expiresAt?: number;
}

export class MemoryCache implements CacheProvider {
  readonly name = 'memory';
  private readonly store = new Map<string, Entry>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs !== undefined && ttlMs > 0 ? Date.now() + ttlMs : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }
}
