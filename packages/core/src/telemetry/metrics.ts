/**
 * Custom Ion Drive metrics.
 *
 * Instruments are created against the **global** OpenTelemetry MeterProvider,
 * which `otel-setup.ts` installs when telemetry is enabled. If telemetry is
 * off, `metrics.getMeter()` returns a no-op meter, so every `record*` call here
 * is a cheap no-op — callers never need to guard.
 *
 * These cover the platform's own signals (HTTP traffic per surface, schema
 * mutations, scheduled-task runs) on top of whatever auto-instrumentation an
 * operator layers in via a preload.
 */

import { type Attributes, type Meter, metrics } from '@opentelemetry/api';
import { ION_ATTR } from './span-attributes.js';

const METER_NAME = '@ionshift/ion-drive-core';

let meter: Meter | undefined;

// Instruments are created lazily on first use so that they bind to the global
// MeterProvider *after* the SDK has installed it, not the bootstrap no-op.
let httpDuration: ReturnType<Meter['createHistogram']> | undefined;
let httpTotal: ReturnType<Meter['createCounter']> | undefined;
let schemaChanges: ReturnType<Meter['createCounter']> | undefined;
let taskRuns: ReturnType<Meter['createCounter']> | undefined;
let taskDuration: ReturnType<Meter['createHistogram']> | undefined;

function getMeter(): Meter {
  if (!meter) meter = metrics.getMeter(METER_NAME);
  return meter;
}

/**
 * Resets cached instruments. Call after (re)installing a MeterProvider so the
 * next `record*` rebinds to it. Used by `otel-setup` and tests.
 */
export function resetMetrics(): void {
  meter = undefined;
  httpDuration = undefined;
  httpTotal = undefined;
  schemaChanges = undefined;
  taskRuns = undefined;
  taskDuration = undefined;
}

/** Records one completed HTTP request: latency histogram + a total counter. */
export function recordHttpRequest(durationMs: number, attributes: Attributes): void {
  if (!httpDuration) {
    httpDuration = getMeter().createHistogram('ion.http.server.duration', {
      description: 'Duration of HTTP server requests handled by Ion Drive',
      unit: 'ms',
    });
  }
  if (!httpTotal) {
    httpTotal = getMeter().createCounter('ion.http.server.requests', {
      description: 'Total HTTP server requests handled by Ion Drive',
    });
  }
  httpDuration.record(durationMs, attributes);
  httpTotal.add(1, attributes);
}

/** Increments the schema-change counter (create/alter/drop of a data object). */
export function recordSchemaChange(change: string, object?: string): void {
  if (!schemaChanges) {
    schemaChanges = getMeter().createCounter('ion.schema.changes', {
      description: 'Total schema changes applied (object create/alter/drop)',
    });
  }
  const attributes: Attributes = { [ION_ATTR.SCHEMA_CHANGE]: change };
  if (object) attributes[ION_ATTR.OBJECT] = object;
  schemaChanges.add(1, attributes);
}

/** Records one task run: a total counter and a duration histogram. */
export function recordTaskRun(durationMs: number, attributes: Attributes): void {
  if (!taskRuns) {
    taskRuns = getMeter().createCounter('ion.task.runs', {
      description: 'Total scheduled/background task runs',
    });
  }
  if (!taskDuration) {
    taskDuration = getMeter().createHistogram('ion.task.duration', {
      description: 'Duration of scheduled/background task runs',
      unit: 'ms',
    });
  }
  taskRuns.add(1, attributes);
  taskDuration.record(durationMs, attributes);
}
