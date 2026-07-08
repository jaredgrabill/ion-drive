/**
 * In-memory {@link RedisApi} fake for unit tests: enough of the key/value and
 * stream/consumer-group semantics to exercise the cache, bus, and dispatcher
 * without a server. Time is manual — `advance(ms)` moves the clock so backoff
 * behavior is testable deterministically. Not exported from the package barrel
 * (test infrastructure, not API).
 */

import type { PendingEntry, RedisApi, StreamEntry } from './redis-api.js';

interface KvEntry {
  value: string;
  expiresAt?: number;
}

interface PelEntry {
  consumer: string;
  deliveredAt: number;
  deliveries: number;
}

interface Group {
  /** Index into the stream's entry array of the next never-delivered entry. */
  cursor: number;
  pel: Map<string, PelEntry>;
}

interface Stream {
  entries: StreamEntry[];
  seq: number;
  groups: Map<string, Group>;
}

export class FakeRedis implements RedisApi {
  private readonly kv = new Map<string, KvEntry>();
  private readonly streams = new Map<string, Stream>();
  private now = 1_000_000;

  /** Moves the fake clock forward. */
  advance(ms: number): void {
    this.now += ms;
  }

  async connect(): Promise<void> {}
  async quit(): Promise<void> {}

  async get(key: string): Promise<string | null> {
    const entry = this.kv.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) {
      this.kv.delete(key);
      return null;
    }
    return entry.value;
  }

  async setValue(key: string, value: string, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs !== undefined && ttlMs > 0 ? this.now + ttlMs : undefined;
    this.kv.set(key, { value, expiresAt });
  }

  async deleteKeys(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.kv.delete(key)) removed += 1;
    }
    return removed;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return [...this.kv.keys()].filter((k) => regex.test(k));
  }

  async addToStream(
    stream: string,
    fields: Record<string, string>,
    maxLen: number,
  ): Promise<string> {
    const s = this.streamFor(stream);
    s.seq += 1;
    const id = `${this.now}-${s.seq}`;
    s.entries.push({ id, fields });
    while (s.entries.length > maxLen) {
      const trimmed = s.entries.shift();
      if (!trimmed) break;
      for (const group of s.groups.values()) {
        group.cursor = Math.max(0, group.cursor - 1);
        group.pel.delete(trimmed.id);
      }
    }
    return id;
  }

  async ensureGroup(stream: string, group: string): Promise<void> {
    const s = this.streamFor(stream);
    if (!s.groups.has(group)) {
      // '$' semantics: only entries added after group creation are delivered.
      s.groups.set(group, { cursor: s.entries.length, pel: new Map() });
    }
  }

  async destroyGroup(stream: string, group: string): Promise<void> {
    this.streams.get(stream)?.groups.delete(group);
  }

  async readGroup(
    stream: string,
    group: string,
    consumer: string,
    count: number,
  ): Promise<StreamEntry[]> {
    const s = this.streamFor(stream);
    const g = s.groups.get(group);
    if (!g) throw new Error(`NOGROUP no such consumer group '${group}'`);
    const batch = s.entries.slice(g.cursor, g.cursor + count);
    g.cursor += batch.length;
    for (const entry of batch) {
      g.pel.set(entry.id, { consumer, deliveredAt: this.now, deliveries: 1 });
    }
    return batch.map((e) => ({ id: e.id, fields: { ...e.fields } }));
  }

  async ack(stream: string, group: string, ...ids: string[]): Promise<void> {
    const g = this.streams.get(stream)?.groups.get(group);
    for (const id of ids) g?.pel.delete(id);
  }

  async pending(stream: string, group: string, count: number): Promise<PendingEntry[]> {
    const g = this.streams.get(stream)?.groups.get(group);
    if (!g) return [];
    return [...g.pel.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, count)
      .map(([id, entry]) => ({
        id,
        consumer: entry.consumer,
        idleMs: this.now - entry.deliveredAt,
        deliveries: entry.deliveries,
      }));
  }

  async claim(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    ids: string[],
  ): Promise<StreamEntry[]> {
    const s = this.streamFor(stream);
    const g = s.groups.get(group);
    if (!g) return [];
    const claimed: StreamEntry[] = [];
    for (const id of ids) {
      const pel = g.pel.get(id);
      if (!pel) continue;
      if (this.now - pel.deliveredAt < minIdleMs) continue;
      const entry = s.entries.find((e) => e.id === id);
      if (!entry) {
        g.pel.delete(id); // trimmed away — Redis reports a tombstone
        continue;
      }
      g.pel.set(id, { consumer, deliveredAt: this.now, deliveries: pel.deliveries + 1 });
      claimed.push({ id: entry.id, fields: { ...entry.fields } });
    }
    return claimed;
  }

  /** Test introspection: raw entries of a stream (e.g. the DLQ). */
  entriesOf(stream: string): StreamEntry[] {
    return this.streams.get(stream)?.entries ?? [];
  }

  private streamFor(name: string): Stream {
    let s = this.streams.get(name);
    if (!s) {
      s = { entries: [], seq: 0, groups: new Map() };
      this.streams.set(name, s);
    }
    return s;
  }
}
