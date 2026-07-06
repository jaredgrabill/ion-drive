/**
 * Log-export tests — pure JSON/CSV serialization and filename generation
 * for the Logs page Export control.
 */

import { describe, expect, it } from 'vitest';
import { logExportFilename, logsToCsv, logsToJson } from './log-export';
import type { LogEntry } from './types';

const entries: LogEntry[] = [
  {
    id: '1',
    timestamp: '2026-07-06T12:00:00.000Z',
    level: 'error',
    message: 'Something "quoted" failed',
    source: 'ion.core',
    traceId: 'abc123',
    attributes: { statusCode: 500, route: '/api/v1/data' },
  },
  {
    id: '2',
    timestamp: '2026-07-06T12:00:01.000Z',
    level: 'info',
    message: 'Server started',
    source: 'ion.server',
    attributes: {},
  },
];

describe('logsToJson', () => {
  it('pretty-prints the entries as a JSON array', () => {
    const json = logsToJson(entries);
    expect(json.startsWith('[\n')).toBe(true);
    const parsed = JSON.parse(json) as LogEntry[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.message).toBe('Something "quoted" failed');
    expect(parsed[1]?.attributes).toEqual({});
  });
});

describe('logsToCsv', () => {
  it('emits a header plus one quoted row per entry', () => {
    const lines = logsToCsv(entries).split('\n');
    expect(lines[0]).toBe('timestamp,level,source,message,traceId,attributes');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"error"');
    expect(lines[1]).toContain('"ion.core"');
  });

  it('escapes embedded quotes by doubling them', () => {
    expect(logsToCsv(entries).split('\n')[1]).toContain('"Something ""quoted"" failed"');
  });

  it('JSON-stringifies attributes and blanks missing traceId/empty attributes', () => {
    const lines = logsToCsv(entries).split('\n');
    expect(lines[1]).toContain('"{""statusCode"":500,""route"":""/api/v1/data""}"');
    // Second entry: no traceId, empty attributes → two trailing empty cells.
    expect(lines[2]?.endsWith('"",""')).toBe(true);
  });

  it('returns only the header for no entries', () => {
    expect(logsToCsv([])).toBe('timestamp,level,source,message,traceId,attributes');
  });
});

describe('logExportFilename', () => {
  it('builds a timestamped, colon-free filename', () => {
    const now = new Date('2026-07-06T12:34:56.789Z');
    expect(logExportFilename('json', now)).toBe('ion-logs-2026-07-06T12-34-56.789Z.json');
    expect(logExportFilename('csv', now)).toBe('ion-logs-2026-07-06T12-34-56.789Z.csv');
  });
});
