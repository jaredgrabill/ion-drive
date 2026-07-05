import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from './memory-cache.js';

describe('MemoryCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves a value', async () => {
    const cache = new MemoryCache();
    await cache.set('k', { n: 1 });
    expect(await cache.get<{ n: number }>('k')).toEqual({ n: 1 });
    expect(await cache.has('k')).toBe(true);
  });

  it('returns undefined for a missing key', async () => {
    const cache = new MemoryCache();
    expect(await cache.get('nope')).toBeUndefined();
    expect(await cache.has('nope')).toBe(false);
  });

  it('expires entries after their TTL', async () => {
    vi.useFakeTimers();
    const cache = new MemoryCache();
    await cache.set('k', 'v', 1000);

    expect(await cache.get('k')).toBe('v');
    vi.advanceTimersByTime(1001);
    expect(await cache.get('k')).toBeUndefined();
    expect(await cache.has('k')).toBe(false);
  });

  it('keeps entries with no TTL indefinitely', async () => {
    vi.useFakeTimers();
    const cache = new MemoryCache();
    await cache.set('k', 'v');
    vi.advanceTimersByTime(60_000_000);
    expect(await cache.get('k')).toBe('v');
  });

  it('delete reports whether the key existed', async () => {
    const cache = new MemoryCache();
    await cache.set('k', 'v');
    expect(await cache.delete('k')).toBe(true);
    expect(await cache.delete('k')).toBe(false);
  });

  it('clear removes everything', async () => {
    const cache = new MemoryCache();
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.clear();
    expect(await cache.has('a')).toBe(false);
    expect(await cache.has('b')).toBe(false);
  });
});
