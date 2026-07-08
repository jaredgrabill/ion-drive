/**
 * The ioredis-backed {@link RedisApi} implementation — the only module that
 * touches the client library. Reply parsing lives here too: ioredis returns
 * stream replies as nested arrays, which are mapped onto the semantic
 * {@link StreamEntry}/{@link PendingEntry} shapes the rest of the plugin uses.
 */

import { Redis } from 'ioredis';
import type { PendingEntry, RedisApi, StreamEntry } from './redis-api.js';

/** Raw stream entry reply: `[id, [field, value, field, value, …]]`. */
type RawEntry = [string, string[] | null] | null;

/** Maps a flat `[k, v, k, v, …]` reply array into a field record. */
function fieldsFromFlat(flat: string[] | null): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!flat) return fields;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const key = flat[i];
    const value = flat[i + 1];
    if (key !== undefined && value !== undefined) fields[key] = value;
  }
  return fields;
}

/** Maps raw entry replies, dropping tombstones (trimmed/deleted entries). */
function entriesFromRaw(raw: RawEntry[] | null | undefined): StreamEntry[] {
  const entries: StreamEntry[] = [];
  for (const item of raw ?? []) {
    if (!item) continue;
    entries.push({ id: item[0], fields: fieldsFromFlat(item[1]) });
  }
  return entries;
}

export class IoredisConnection implements RedisApi {
  private readonly client: Redis;

  constructor(url: string) {
    // lazyConnect so construction never blocks; `connect()` (called from the
    // plugin's setup) surfaces connectivity problems as a clear boot failure.
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async quit(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setValue(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined && ttlMs > 0) {
      await this.client.set(key, value, 'PX', ttlMs);
    } else {
      await this.client.set(key, value);
    }
  }

  async deleteKeys(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) > 0;
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  async addToStream(
    stream: string,
    fields: Record<string, string>,
    maxLen: number,
  ): Promise<string> {
    const flat = Object.entries(fields).flat();
    const id = await this.client.xadd(stream, 'MAXLEN', '~', maxLen, '*', ...flat);
    return id ?? '';
  }

  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.client.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    } catch (err) {
      if (err instanceof Error && err.message.includes('BUSYGROUP')) return;
      throw err;
    }
  }

  async destroyGroup(stream: string, group: string): Promise<void> {
    try {
      await this.client.xgroup('DESTROY', stream, group);
    } catch {
      // best-effort cleanup — the stream may already be gone
    }
  }

  async readGroup(
    stream: string,
    group: string,
    consumer: string,
    count: number,
  ): Promise<StreamEntry[]> {
    const reply = (await this.client.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      count,
      'STREAMS',
      stream,
      '>',
    )) as [string, RawEntry[]][] | null;
    const first = reply?.[0];
    return entriesFromRaw(first?.[1]);
  }

  async ack(stream: string, group: string, ...ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.xack(stream, group, ...ids);
  }

  async pending(stream: string, group: string, count: number): Promise<PendingEntry[]> {
    const reply = (await this.client.xpending(stream, group, '-', '+', count)) as
      | [string, string, number, number][]
      | null;
    return (reply ?? []).map(([id, consumer, idleMs, deliveries]) => ({
      id,
      consumer,
      idleMs,
      deliveries,
    }));
  }

  async claim(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    ids: string[],
  ): Promise<StreamEntry[]> {
    if (ids.length === 0) return [];
    const reply = (await this.client.xclaim(stream, group, consumer, minIdleMs, ...ids)) as
      | RawEntry[]
      | null;
    return entriesFromRaw(reply);
  }
}
