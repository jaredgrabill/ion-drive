/**
 * The narrow, semantic Redis command surface this plugin depends on.
 *
 * Everything else in the package (cache, bus, dispatcher) is written against
 * {@link RedisApi} rather than a client library, so unit tests run against the
 * in-memory fake in `fake-redis.ts` and the ioredis specifics stay confined to
 * `ioredis-connection.ts`.
 */

/** One stream entry: the Redis-assigned id plus its field map. */
export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

/** One XPENDING row for a consumer group. */
export interface PendingEntry {
  id: string;
  /** Consumer currently holding the entry. */
  consumer: string;
  /** Milliseconds since the entry was last delivered. */
  idleMs: number;
  /** Times the entry has been delivered (first delivery counts as 1). */
  deliveries: number;
}

/** The semantic command set — key/value with TTL, key scans, and streams. */
export interface RedisApi {
  // --- key/value (cache) ---
  get(key: string): Promise<string | null>;
  /** SET, with `PX ttlMs` when a positive TTL is given. */
  setValue(key: string, value: string, ttlMs?: number): Promise<void>;
  deleteKeys(...keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  /** Full SCAN loop for keys matching `pattern` (e.g. `ion:cache:*`). */
  scanKeys(pattern: string): Promise<string[]>;

  // --- streams (bus) ---
  /** XADD with approximate MAXLEN trimming. Returns the new entry id. */
  addToStream(stream: string, fields: Record<string, string>, maxLen: number): Promise<string>;
  /** XGROUP CREATE … $ MKSTREAM; existing groups are fine. */
  ensureGroup(stream: string, group: string): Promise<void>;
  /** XGROUP DESTROY (used to clean up per-instance groups on shutdown). */
  destroyGroup(stream: string, group: string): Promise<void>;
  /** XREADGROUP … COUNT n STREAMS s `>` — new (never-delivered) entries. */
  readGroup(stream: string, group: string, consumer: string, count: number): Promise<StreamEntry[]>;
  /** XACK. */
  ack(stream: string, group: string, ...ids: string[]): Promise<void>;
  /** XPENDING summary rows (oldest first). */
  pending(stream: string, group: string, count: number): Promise<PendingEntry[]>;
  /**
   * XCLAIM with a min-idle guard: atomically takes over entries another (or a
   * crashed) consumer holds. Returns the successfully claimed entries — an
   * entry someone else claimed in between simply isn't in the result.
   */
  claim(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    ids: string[],
  ): Promise<StreamEntry[]>;

  // --- lifecycle ---
  connect(): Promise<void>;
  quit(): Promise<void>;
}
