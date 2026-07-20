/**
 * @module @ion-drive/plugin-redis
 *
 * Ion Drive plugin backing platform infrastructure with Redis:
 *
 *  - **Cache** (default on): swaps core's in-process MemoryCache for a
 *    Redis-backed {@link RedisCache} — coherent across instances.
 *  - **Message bus** (opt-in): swaps the Postgres transactional outbox for a
 *    Redis Streams bus + dispatcher. Enable deliberately — you trade the
 *    outbox's publish-atomic-with-commit guarantee and the `/api/v1/events`
 *    ledger/realtime surfaces for broker-based delivery (see the README).
 *
 * Usage — programmatic:
 * ```ts
 * import { redisPlugin } from '@ion-drive/plugin-redis';
 * await createServer(config, { plugins: [redisPlugin({ url: 'redis://cache:6379' })] });
 * ```
 * or via env: `ION_PLUGINS=@ion-drive/plugin-redis` with `ION_REDIS_URL` (or
 * `REDIS_URL`); set `ION_REDIS_BUS=true` to also swap the bus.
 */

import { CACHE_SERVICE, type IonPlugin, MESSAGE_BUS, definePlugin } from '@ion-drive/core';
import { IoredisConnection } from './ioredis-connection.js';
import type { RedisApi } from './redis-api.js';
import { RedisCache } from './redis-cache.js';
import { RedisDispatcher } from './redis-dispatcher.js';
import { RedisStreamsBus } from './streams-bus.js';

export type { PendingEntry, RedisApi, StreamEntry } from './redis-api.js';
export { RedisCache } from './redis-cache.js';
export { RedisDispatcher, type RedisDispatcherOptions } from './redis-dispatcher.js';
export {
  DEFAULT_STREAM_MAX_LEN,
  eventFromFields,
  eventToFields,
  RedisStreamsBus,
} from './streams-bus.js';

export interface RedisPluginOptions {
  /** Connection URL. Falls back to `ION_REDIS_URL`, `REDIS_URL`, then localhost. */
  url?: string;
  /** Namespace prefix for every key this plugin touches (default `ion:`). */
  keyPrefix?: string;
  /** Swap the platform cache (default true). */
  cache?: boolean;
  /** Swap the message bus (default: only when `ION_REDIS_BUS` is truthy). */
  bus?: boolean;
  /** Approximate MAXLEN the event stream is trimmed to. */
  streamMaxLen?: number;
  /** Dispatcher poll cadence in ms (publishes also wake it). */
  pollIntervalMs?: number;
  /** Max entries read per consumer group per tick. */
  batchSize?: number;
  /** Retry budget for a failed delivery before dead-lettering. */
  maxAttempts?: number;
  /** Per-delivery handler timeout (ms). */
  handlerTimeoutMs?: number;
  /** Approximate MAXLEN for the dead-letter stream. */
  dlqMaxLen?: number;
  /** Injected connection (tests). When set, `url` is ignored. */
  connection?: RedisApi;
}

/**
 * Strict boolean env parsing, mirroring core's `envBool` (issue #25): unknown
 * spellings are a boot-time error naming the variable, never a silent default.
 * (Local copy rather than a core import so the plugin keeps its wide core
 * peer-dependency range.)
 */
function envFlag(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  throw new Error(
    `${name} must be a boolean — got "${value}". Accepted values: true, 1, yes, on (enable) or false, 0, no, off (disable), case-insensitive. Unset the variable to use its default.`,
  );
}

/** Swaps in the Streams bus + dispatcher when opted in (and events are on). */
function setupBus(
  ctx: Parameters<IonPlugin['setup']>[0],
  redis: RedisApi,
  keyPrefix: string,
  options: RedisPluginOptions,
): RedisDispatcher | undefined {
  const busRequested = options.bus ?? envFlag('ION_REDIS_BUS', process.env.ION_REDIS_BUS);
  if (!busRequested) return undefined;
  if (!ctx.config.eventsEnabled) {
    ctx.logger.warn('Redis bus requested but ION_EVENTS_ENABLED=false — bus not swapped');
    return undefined;
  }

  const bus = new RedisStreamsBus(redis, { keyPrefix, streamMaxLen: options.streamMaxLen });
  ctx.registry.set(MESSAGE_BUS, bus);
  ctx.logger.warn(
    'Message bus swapped to Redis Streams — outbox ledger/realtime surfaces are inactive; ' +
      'delivery is at-least-once and publishes are not transactional with Postgres writes',
  );
  return new RedisDispatcher(redis, bus, {
    logger: ctx.logger,
    pollIntervalMs: options.pollIntervalMs ?? ctx.config.eventsPollIntervalMs,
    batchSize: options.batchSize,
    maxAttempts: options.maxAttempts,
    handlerTimeoutMs: options.handlerTimeoutMs,
    dlqMaxLen: options.dlqMaxLen,
  });
}

/** Creates the plugin. Options fall back to environment variables at load time. */
export function redisPlugin(options: RedisPluginOptions = {}): IonPlugin {
  let redis: RedisApi | undefined;
  let dispatcher: RedisDispatcher | undefined;

  return definePlugin({
    name: 'redis',
    async setup(ctx) {
      const url =
        options.url ??
        process.env.ION_REDIS_URL ??
        process.env.REDIS_URL ??
        'redis://localhost:6379';
      const keyPrefix = options.keyPrefix ?? 'ion:';

      redis = options.connection ?? new IoredisConnection(url);
      try {
        await redis.connect();
      } catch (err) {
        throw new Error(
          `Cannot reach Redis at ${url} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (options.cache ?? true) {
        ctx.registry.set(CACHE_SERVICE, new RedisCache(redis, `${keyPrefix}cache:`));
        ctx.logger.info('Cache swapped to Redis', { url });
      }

      dispatcher = setupBus(ctx, redis, keyPrefix, options);
    },

    async onReady() {
      // Start draining only once the server is assembled, mirroring core's
      // outbox dispatcher (block subscriptions re-register during assembly).
      dispatcher?.start();
    },

    async onShutdown() {
      await dispatcher?.stop();
      dispatcher = undefined;
      await redis?.quit();
      redis = undefined;
    },
  });
}

/** Env-driven default export for `ION_PLUGINS=@ion-drive/plugin-redis`. */
export default redisPlugin();
