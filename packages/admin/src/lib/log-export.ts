/**
 * Log export helpers — pure serializers for the Logs page Export control.
 *
 * `logsToJson` / `logsToCsv` turn the currently-displayed (post-filter,
 * live-tail included) entries into a downloadable string; `logExportFilename`
 * builds a timestamped, filesystem-safe name; `downloadText` performs the
 * client-side Blob download (same mechanics as the DataGrid CSV export).
 * Serializers are pure so they're unit-testable without a DOM.
 */

import type { LogEntry } from './types';

/** CSV column order — mirrors the visible log table plus trace/attributes. */
const CSV_COLUMNS = ['timestamp', 'level', 'source', 'message', 'traceId', 'attributes'] as const;

/** Quote a CSV cell, doubling embedded quotes (matches the DataGrid export). */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Serialize entries as a pretty-printed JSON array. */
export function logsToJson(entries: LogEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/** Serialize entries as CSV; attributes are JSON-stringified into one cell. */
export function logsToCsv(entries: LogEntry[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = entries.map((entry) =>
    CSV_COLUMNS.map((column) => {
      if (column === 'attributes') {
        return csvCell(
          Object.keys(entry.attributes).length === 0 ? '' : JSON.stringify(entry.attributes),
        );
      }
      return csvCell(entry[column] ?? '');
    }).join(','),
  );
  return [header, ...lines].join('\n');
}

/** `ion-logs-<ISO timestamp>.<ext>`, with `:` swapped for `-` (Windows-safe). */
export function logExportFilename(format: 'json' | 'csv', now: Date = new Date()): string {
  return `ion-logs-${now.toISOString().replace(/:/g, '-')}.${format}`;
}

/** Trigger a client-side download of `content` as `filename`. */
export function downloadText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
