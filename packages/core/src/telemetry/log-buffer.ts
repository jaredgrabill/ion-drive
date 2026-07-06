/**
 * LogBuffer — circular in-memory buffer for structured log entries.
 *
 * Captures log entries from the pino logger (attached as one arm of the
 * server's `pino.multistream`, see {@link createLogBufferStream}) into a
 * fixed-size ring buffer. Entries are queryable by level, source, time range,
 * and full-text search on the message + attribute values, and live listeners
 * can subscribe for real-time tailing (backs the `/api/v1/logs/stream` SSE
 * endpoint).
 *
 * This gives the admin console an "instant logs" view without requiring an
 * external observability stack (Loki, Elasticsearch). The buffer is
 * intentionally ephemeral — it's for recent debugging, not long-term
 * retention. Size is configurable via `ION_LOG_BUFFER_SIZE` (default 2000).
 */

import { Writable } from 'node:stream';
import { nanoid } from 'nanoid';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  id: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  level: LogLevel;
  message: string;
  /** Module that emitted the log (child logger name, or a derived origin). */
  source: string;
  traceId?: string;
  spanId?: string;
  /** Remaining structured fields from the pino record. */
  attributes: Record<string, unknown>;
}

export interface LogQuery {
  level?: LogLevel;
  source?: string;
  /** Case-insensitive full-text match on message + attribute values. */
  search?: string;
  /** ISO timestamp; only entries strictly after this. */
  since?: string;
  /** Page size — default 100, max 500. */
  limit?: number;
  offset?: number;
}

export type LogListener = (entry: LogEntry) => void;

const DEFAULT_MAX_SIZE = 2000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private readonly maxSize: number;
  private readonly listeners = new Set<LogListener>();

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = Math.max(1, maxSize);
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.entries.length;
  }

  /** Appends an entry, evicting the oldest when full, and notifies listeners. */
  push(entry: Omit<LogEntry, 'id'>): void {
    const stored: LogEntry = { id: nanoid(12), ...entry };
    this.entries.push(stored);
    if (this.entries.length > this.maxSize) {
      this.entries.splice(0, this.entries.length - this.maxSize);
    }
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch {
        // A faulty listener (e.g. a dying SSE socket) must not break logging.
      }
    }
  }

  /** Queries the buffer, newest entries first. */
  query(params: LogQuery = {}): { data: LogEntry[]; total: number } {
    const search = params.search?.toLowerCase();
    const matches = (entry: LogEntry): boolean => {
      if (params.level && entry.level !== params.level) return false;
      if (params.source && entry.source !== params.source) return false;
      if (params.since && entry.timestamp <= params.since) return false;
      if (search) {
        const haystack = `${entry.message} ${JSON.stringify(entry.attributes)}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    };

    const filtered: LogEntry[] = [];
    // Walk newest → oldest so results are already in display order.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry && matches(entry)) filtered.push(entry);
    }

    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(params.offset ?? 0, 0);
    return { data: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  /** Distinct sources present in the buffer (for filter dropdowns). */
  sources(): string[] {
    return [...new Set(this.entries.map((e) => e.source))].sort();
  }

  /** Registers a live listener; returns an unsubscribe function. */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

// --- pino integration -------------------------------------------------

/** Maps a pino numeric level to the buffer's coarse level set. */
function levelFor(level: number): LogLevel {
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';
  return 'debug';
}

// Fields consumed into first-class LogEntry slots rather than attributes.
const RESERVED = new Set(['level', 'time', 'msg', 'v', 'pid', 'hostname', 'name']);

/** Best-effort origin for a pino record (child logger name, or heuristics). */
function sourceFor(record: Record<string, unknown>): string {
  if (typeof record.name === 'string' && record.name) return record.name;
  if (record.reqId !== undefined || record.req !== undefined || record.res !== undefined) {
    return 'http';
  }
  return 'core';
}

function ingest(buffer: LogBuffer, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed);
  } catch {
    buffer.push({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: trimmed,
      source: 'core',
      attributes: {},
    });
    return;
  }

  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!RESERVED.has(key)) attributes[key] = value;
  }

  buffer.push({
    timestamp: new Date(typeof record.time === 'number' ? record.time : Date.now()).toISOString(),
    level: levelFor(typeof record.level === 'number' ? record.level : 30),
    message: typeof record.msg === 'string' ? record.msg : trimmed,
    source: sourceFor(record),
    traceId: typeof record.trace_id === 'string' ? record.trace_id : undefined,
    spanId: typeof record.span_id === 'string' ? record.span_id : undefined,
    attributes,
  });
}

/**
 * A Writable that feeds pino JSON log lines into a {@link LogBuffer}.
 * Intended for use inside `pino.multistream([...])` (mirrors the OTel bridge
 * in `log-bridge.ts`).
 */
export function createLogBufferStream(buffer: LogBuffer): Writable {
  let pending = '';
  return new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString();
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        ingest(buffer, pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      callback();
    },
    final(callback) {
      if (pending) ingest(buffer, pending);
      callback();
    },
  });
}
