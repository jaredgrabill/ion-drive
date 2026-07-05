/**
 * Pino → OpenTelemetry logs bridge.
 *
 * Fastify logs via pino as newline-delimited JSON. {@link createOtelLogStream}
 * returns a Writable that parses those records and re-emits them through the
 * OpenTelemetry Logs API, so they reach the OTLP logs backend (e.g. Loki via a
 * collector) with severity, timestamp, and structured attributes preserved —
 * correlated with traces by the active span context.
 *
 * It is wired into Fastify's logger as one arm of a `pino.multistream` only
 * when `otelLogsEnabled` is set, leaving normal stdout logging intact. When the
 * OTel SDK has no LoggerProvider installed, `logs.getLogger()` yields a no-op
 * logger, so this stream simply discards — harmless.
 */

import { Writable } from 'node:stream';
import { SeverityNumber, logs } from '@opentelemetry/api-logs';

const LOGGER_NAME = '@ionshift/ion-drive-core';

/** Maps a pino numeric level to an OTel severity number + text. */
function severityFor(level: number): { number: SeverityNumber; text: string } {
  if (level >= 60) return { number: SeverityNumber.FATAL, text: 'FATAL' };
  if (level >= 50) return { number: SeverityNumber.ERROR, text: 'ERROR' };
  if (level >= 40) return { number: SeverityNumber.WARN, text: 'WARN' };
  if (level >= 30) return { number: SeverityNumber.INFO, text: 'INFO' };
  if (level >= 20) return { number: SeverityNumber.DEBUG, text: 'DEBUG' };
  return { number: SeverityNumber.TRACE, text: 'TRACE' };
}

// Fields consumed into first-class LogRecord slots rather than attributes.
const RESERVED = new Set(['level', 'time', 'msg', 'v']);

function emit(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed);
  } catch {
    // Non-JSON line (e.g. a raw write) — forward as a plain info body.
    logs.getLogger(LOGGER_NAME).emit({ severityNumber: SeverityNumber.INFO, body: trimmed });
    return;
  }

  const level = typeof record.level === 'number' ? record.level : 30;
  const severity = severityFor(level);
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!RESERVED.has(key)) attributes[key] = value;
  }

  logs.getLogger(LOGGER_NAME).emit({
    severityNumber: severity.number,
    severityText: severity.text,
    body: typeof record.msg === 'string' ? record.msg : trimmed,
    timestamp: typeof record.time === 'number' ? record.time : Date.now(),
    attributes: attributes as Record<string, string | number | boolean>,
  });
}

/**
 * A Writable that forwards pino JSON log lines to the OpenTelemetry Logs API.
 * Intended for use inside `pino.multistream([...])`.
 */
export function createOtelLogStream(): Writable {
  let buffer = '';
  return new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      callback();
    },
    final(callback) {
      if (buffer) emit(buffer);
      callback();
    },
  });
}
