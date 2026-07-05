/**
 * OpenTelemetry SDK lifecycle for Ion Drive.
 *
 * {@link startTelemetry} builds a `NodeSDK` from the platform config and starts
 * it, installing global tracer/meter/logger providers that the rest of the
 * telemetry module (manual request spans, custom metrics, the log bridge) binds
 * to. Signals are wired conditionally:
 *
 *  - **Traces**  → OTLP/HTTP (`otelEnabled && otelTracesEnabled`)
 *  - **Metrics** → a Prometheus scrape endpoint (`metricsEnabled`, default on)
 *                  and/or OTLP/HTTP push (`otelEnabled && otelMetricsEnabled`)
 *  - **Logs**    → OTLP/HTTP (`otelEnabled && otelLogsEnabled`), fed by the
 *                  pino → OTel bridge in `log-bridge.ts`
 *
 * The returned handle exposes `renderPrometheus()` (used by the `/metrics`
 * route) and `shutdown()` (flushes exporters on server close). When neither
 * telemetry nor the metrics endpoint is enabled, a no-op handle is returned so
 * callers need no branching.
 *
 * Note on auto-instrumentation: this starts the SDK from inside the running
 * process, so already-imported modules (http, pg, fastify) are not retroactively
 * patched. Ion Drive's manual Fastify request spans (see `request-tracing.ts`)
 * therefore carry request traces on their own. Operators who want deep
 * auto-instrumentation can preload the SDK via `node --import`.
 */

import { type DiagLogFunction, DiagLogLevel, diag } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { type IMetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { IonDriveConfig } from '../config/index.js';
import { resetMetrics } from './metrics.js';

/** Minimal logger shape (Fastify/pino compatible) used for diagnostics. */
export interface TelemetryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

export interface TelemetryHandle {
  /** True when any signal (traces/metrics/logs) is active. */
  readonly enabled: boolean;
  /** True when the Prometheus scrape endpoint should be served. */
  readonly metricsEndpointEnabled: boolean;
  /** Renders the current metrics in Prometheus text exposition format. */
  renderPrometheus(): Promise<string>;
  /** Flushes and shuts down all exporters. Safe to call when disabled. */
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: TelemetryHandle = {
  enabled: false,
  metricsEndpointEnabled: false,
  async renderPrometheus() {
    return '# Ion Drive metrics are disabled\n';
  },
  async shutdown() {
    /* nothing to flush */
  },
};

/** Bridges OpenTelemetry's internal diagnostics into the platform logger. */
function installDiagLogger(logger: TelemetryLogger): void {
  const fn =
    (level: 'warn' | 'error' | 'debug' | 'info'): DiagLogFunction =>
    (message, ...args) => {
      const line = args.length ? `${message} ${args.join(' ')}` : message;
      (logger[level] ?? logger.info).call(logger, `[otel] ${line}`);
    };
  diag.setLogger(
    {
      verbose: fn('debug'),
      debug: fn('debug'),
      info: fn('info'),
      warn: fn('warn'),
      error: fn('error'),
    },
    DiagLogLevel.WARN,
  );
}

/**
 * Starts the OpenTelemetry SDK per config. Returns a handle to render the
 * Prometheus endpoint and to shut down cleanly. A no-op handle is returned
 * when both telemetry and the metrics endpoint are disabled.
 */
export function startTelemetry(config: IonDriveConfig, logger: TelemetryLogger): TelemetryHandle {
  const wantsMetricsEndpoint = config.metricsEnabled;
  if (!config.otelEnabled && !wantsMetricsEndpoint) {
    return NOOP_HANDLE;
  }

  installDiagLogger(logger);

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.otelServiceName,
    [ATTR_SERVICE_VERSION]: '0.1.0',
    'deployment.environment.name': config.nodeEnv,
  });

  const endpoint = config.otelExporterOtlpEndpoint.replace(/\/$/, '');
  const metricReaders: IMetricReader[] = [];

  // Prometheus scrape endpoint — served through Fastify (`/metrics`), so the
  // exporter's own HTTP server is suppressed with `preventServerStart`.
  let prometheusExporter: PrometheusExporter | undefined;
  if (wantsMetricsEndpoint) {
    prometheusExporter = new PrometheusExporter({ preventServerStart: true });
    metricReaders.push(prometheusExporter);
  }

  // OTLP metric push (optional, in addition to Prometheus).
  if (config.otelEnabled && config.otelMetricsEnabled) {
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      }),
    );
  }

  const traceExporter =
    config.otelEnabled && config.otelTracesEnabled
      ? new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })
      : undefined;

  const logRecordProcessors =
    config.otelEnabled && config.otelLogsEnabled
      ? [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
          }),
        ]
      : undefined;

  const sdk = new NodeSDK({
    resource,
    // Only our static resource — skip the default async detectors, which
    // otherwise trigger "async attributes not settled" warnings when the
    // Prometheus endpoint serializes the resource synchronously.
    resourceDetectors: [],
    traceExporter,
    metricReaders: metricReaders.length ? metricReaders : undefined,
    logRecordProcessors,
    // Manual instrumentation only (see module JSDoc) — no auto-instrumentations.
    instrumentations: [],
  });

  sdk.start();
  // Instruments cached before start() would bind to the bootstrap no-op meter;
  // drop them so they rebind to the freshly-installed MeterProvider.
  resetMetrics();

  const signals = [
    traceExporter && 'traces→otlp',
    prometheusExporter && 'metrics→prometheus',
    config.otelEnabled && config.otelMetricsEnabled && 'metrics→otlp',
    logRecordProcessors && 'logs→otlp',
  ].filter(Boolean);
  logger.info(`Telemetry started (${signals.join(', ') || 'none'})`);

  const serializer = new PrometheusSerializer();

  return {
    enabled: true,
    metricsEndpointEnabled: Boolean(prometheusExporter),
    async renderPrometheus() {
      if (!prometheusExporter) return '# Ion Drive metrics endpoint is disabled\n';
      const { resourceMetrics, errors } = await prometheusExporter.collect();
      if (errors.length) {
        logger.warn(`Metrics collection reported ${errors.length} error(s)`);
      }
      return serializer.serialize(resourceMetrics);
    },
    async shutdown() {
      try {
        await sdk.shutdown();
      } catch (err) {
        logger.error(`Telemetry shutdown failed: ${(err as Error).message}`);
      }
    },
  };
}
