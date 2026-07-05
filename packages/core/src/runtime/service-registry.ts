/**
 * Service registry — the composition seam that lets plugins swap core services.
 *
 * Ion Drive wires its infrastructure services (cache, email, message bus,
 * logger) through a tiny keyed container instead of a heavyweight DI framework.
 * Core registers a **default** implementation for each service at boot; a
 * plugin's `setup` can then call {@link ServiceRegistry.set} to transparently
 * **replace** it (last write wins), which is how e.g. a Redis plugin takes over
 * caching without any edit to core. This mirrors the pluggable `AuthProvider`
 * seam (see ADR-010) and the manual constructor-injection convention already
 * used across the engines (see ADR-015).
 *
 * Services are addressed by a typed {@link ServiceToken} so call sites stay
 * type-safe without the registry needing to import every provider interface —
 * each provider module declares its own token next to its port.
 */

/**
 * A typed handle for a service slot. The phantom `__type` carries the service's
 * interface for compile-time inference at `get`/`set`/`require` call sites; it
 * is never assigned at runtime.
 */
export interface ServiceToken<T> {
  readonly key: string;
  /** Phantom type carrier — never present at runtime. */
  readonly __type?: (value: T) => void;
}

/** Creates a typed service token. Declare one per service, next to its port. */
export function serviceToken<T>(key: string): ServiceToken<T> {
  return { key };
}

/** Thrown when a required service has no registered implementation. */
export class ServiceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceRegistryError';
  }
}

/**
 * A keyed singleton container. Not thread-safe by design — it is populated
 * during synchronous server assembly and read afterwards.
 */
export class ServiceRegistry {
  private readonly services = new Map<string, unknown>();

  /** Registers (or replaces) the implementation for a token. Last write wins. */
  set<T>(token: ServiceToken<T>, impl: T): this {
    this.services.set(token.key, impl);
    return this;
  }

  /** Returns the implementation for a token, or `undefined` if unregistered. */
  get<T>(token: ServiceToken<T>): T | undefined {
    return this.services.get(token.key) as T | undefined;
  }

  /** Whether a token has a registered implementation. */
  has<T>(token: ServiceToken<T>): boolean {
    return this.services.has(token.key);
  }

  /** Returns the implementation for a token, or throws if unregistered. */
  require<T>(token: ServiceToken<T>): T {
    const impl = this.services.get(token.key);
    if (impl === undefined) {
      throw new ServiceRegistryError(`No implementation registered for service "${token.key}"`);
    }
    return impl as T;
  }

  /** The keys of every registered service (for diagnostics/logging). */
  registeredKeys(): string[] {
    return [...this.services.keys()];
  }
}
