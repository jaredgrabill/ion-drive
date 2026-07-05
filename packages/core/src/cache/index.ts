/**
 * Cache module barrel — the {@link CacheProvider} port, the default in-memory
 * adapter, and the registry token used to resolve/replace it.
 */

import { serviceToken } from '../runtime/service-registry.js';
import type { CacheProvider } from './cache-provider.js';

export type { CacheProvider } from './cache-provider.js';
export { MemoryCache } from './memory-cache.js';

/** Registry token for the platform cache. */
export const CACHE_SERVICE = serviceToken<CacheProvider>('cache');
