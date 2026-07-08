/**
 * Unit tests for RedisCache over the in-memory fake: JSON round-trips, TTL
 * expiry, prefix isolation, and clear().
 */

import { describe, expect, it } from 'vitest';
import { FakeRedis } from './fake-redis.js';
import { RedisCache } from './redis-cache.js';

describe('RedisCache', () => {
  it('round-trips JSON values', async () => {
    const cache = new RedisCache(new FakeRedis(), 'ion:cache:');
    await cache.set('user', { id: 7, name: 'Ada' });
    expect(await cache.get('user')).toEqual({ id: 7, name: 'Ada' });
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('honors TTL via the fake clock', async () => {
    const redis = new FakeRedis();
    const cache = new RedisCache(redis, 'ion:cache:');
    await cache.set('temp', 'value', 1000);
    expect(await cache.get('temp')).toBe('value');
    redis.advance(1001);
    expect(await cache.get('temp')).toBeUndefined();
    expect(await cache.has('temp')).toBe(false);
  });

  it('delete reports prior existence', async () => {
    const cache = new RedisCache(new FakeRedis(), 'ion:cache:');
    await cache.set('k', 1);
    expect(await cache.delete('k')).toBe(true);
    expect(await cache.delete('k')).toBe(false);
  });

  it('clear removes only its own prefix', async () => {
    const redis = new FakeRedis();
    const cache = new RedisCache(redis, 'ion:cache:');
    await cache.set('a', 1);
    await cache.set('b', 2);
    await redis.setValue('other:key', 'untouched');
    await cache.clear();
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();
    expect(await redis.get('other:key')).toBe('untouched');
  });

  it('treats unparseable foreign values as misses', async () => {
    const redis = new FakeRedis();
    const cache = new RedisCache(redis, 'ion:cache:');
    await redis.setValue('ion:cache:weird', '{not json');
    expect(await cache.get('weird')).toBeUndefined();
  });
});
