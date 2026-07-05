/**
 * Cache port.
 *
 * Ion Drive reads/writes ephemeral values through the {@link CacheProvider}
 * interface. The default is an in-process {@link MemoryCache}; a Redis plugin
 * replaces it by registering a `RedisCache` under the same token (see ADR-015).
 * Values are treated as opaque — callers own (de)serialization.
 */

/** A minimal key/value cache with optional per-entry TTL. */
export interface CacheProvider {
  /** The provider's name (for diagnostics/logging). */
  readonly name: string;

  /** Returns the cached value, or `undefined` if missing/expired. */
  get<T>(key: string): Promise<T | undefined>;

  /** Stores a value, optionally expiring after `ttlMs` milliseconds. */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;

  /** Removes a key. Returns whether it existed. */
  delete(key: string): Promise<boolean>;

  /** Whether a live (unexpired) entry exists for `key`. */
  has(key: string): Promise<boolean>;

  /** Removes every entry. */
  clear(): Promise<void>;
}
