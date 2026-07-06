/**
 * Ion Drive telemetry (Phase 5, Observability).
 *
 * Public surface for the OpenTelemetry integration:
 *  - {@link startTelemetry} — start the SDK; returns a handle for the `/metrics`
 *    route and clean shutdown.
 *  - {@link installRequestTracing} — installs global Fastify hooks emitting
 *    per-request spans and `ion.http.server.*` metrics.
 *  - {@link recordSchemaChange}, {@link recordTaskRun} — custom metric helpers
 *    used by the schema engine and task runner.
 *  - {@link createOtelLogStream} — pino → OTel logs bridge stream.
 */

export { startTelemetry } from './otel-setup.js';
export type { TelemetryHandle, TelemetryLogger } from './otel-setup.js';
export { installRequestTracing } from './request-tracing.js';
export {
  recordActionRun,
  recordHookDelivery,
  recordHttpRequest,
  recordSchemaChange,
  recordTaskRun,
  resetMetrics,
} from './metrics.js';
export { createOtelLogStream } from './log-bridge.js';
export { ION_ATTR, surfaceForPath } from './span-attributes.js';
export { LogBuffer, createLogBufferStream } from './log-buffer.js';
export type { LogEntry, LogLevel, LogQuery } from './log-buffer.js';
export { TrafficStats, trafficStats } from './traffic-stats.js';
export type {
  ErrorEntry,
  TrafficPeriod,
  TrafficPoint,
  TrafficSample,
  TrafficSummary,
} from './traffic-stats.js';
