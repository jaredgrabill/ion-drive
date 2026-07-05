/**
 * Fastify request tracing + metrics.
 *
 * Registered as a plugin, this emits one span and one metric sample per HTTP
 * request. It uses the OpenTelemetry API directly, so when the SDK is running
 * (see `otel-setup.ts`) spans flow to the configured OTLP backend and the
 * `ion.http.server.*` metrics appear on the Prometheus endpoint; when the SDK
 * is off, the API's no-op implementations make every call a cheap no-op.
 *
 * Health checks and the metrics scrape endpoint are skipped to avoid drowning
 * the signal in liveness/scrape noise.
 */

import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recordHttpRequest } from './metrics.js';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ION_ATTR,
  surfaceForPath,
} from './span-attributes.js';

const TRACER_NAME = '@ionshift/ion-drive-core';

/** Per-request telemetry state, kept off the request object via a WeakMap. */
interface RequestTelemetry {
  span: Span;
  startNs: bigint;
}
const state = new WeakMap<FastifyRequest, RequestTelemetry>();

/** Paths that should not produce spans/metrics (liveness + self-scrape). */
function isIgnored(path: string): boolean {
  return path === '/health' || path === '/metrics';
}

/** The matched route template if Fastify resolved one, else the raw path. */
function routeOf(request: FastifyRequest): string {
  return request.routeOptions?.url ?? request.url.split('?')[0] ?? request.url;
}

/**
 * Installs request tracing + metrics hooks directly on the server instance.
 *
 * Added directly (not via `register`) so the `onRequest`/`onResponse` hooks are
 * global and fire for every route, mirroring `installSessionMiddleware` /
 * `installRbacEnforcement`. Registering as an encapsulated plugin would scope
 * the hooks to that plugin's context and miss sibling routes.
 */
export function installRequestTracing(fastify: FastifyInstance): void {
  const tracer = trace.getTracer(TRACER_NAME);

  fastify.addHook('onRequest', (request, _reply, hookDone) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (isIgnored(path)) return hookDone();

    const surface = surfaceForPath(path);
    const span = tracer.startSpan(`${request.method} ${routeOf(request)}`, {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: request.method,
        [ATTR_URL_PATH]: path,
        [ION_ATTR.SURFACE]: surface,
      },
    });
    state.set(request, { span, startNs: process.hrtime.bigint() });
    hookDone();
  });

  fastify.addHook('onResponse', (request, reply, hookDone) => {
    const entry = state.get(request);
    if (!entry) return hookDone();
    state.delete(request);

    const durationMs = Number(process.hrtime.bigint() - entry.startNs) / 1e6;
    const path = request.url.split('?')[0] ?? request.url;
    const route = routeOf(request);
    const surface = surfaceForPath(path);
    const status = reply.statusCode;

    entry.span.setAttribute(ATTR_HTTP_ROUTE, route);
    entry.span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);
    if (status >= 500) {
      entry.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    entry.span.end();

    recordHttpRequest(durationMs, {
      [ATTR_HTTP_REQUEST_METHOD]: request.method,
      [ATTR_HTTP_ROUTE]: route,
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
      [ION_ATTR.SURFACE]: surface,
    });
    hookDone();
  });

  fastify.addHook('onError', (request, _reply, error, hookDone) => {
    const entry = state.get(request);
    if (entry) {
      entry.span.recordException(error);
      entry.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }
    hookDone();
  });
}
