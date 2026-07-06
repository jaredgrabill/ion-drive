/**
 * TrafficStats — in-memory time-bucketed API traffic aggregation.
 *
 * The OpenTelemetry metrics pipeline exposes *cumulative* counters (perfect
 * for Prometheus scraping, useless for "requests over the last 6 hours"
 * without a TSDB). This module keeps its own lightweight per-minute ring
 * buffer — request counts by API surface, error counts, and a fixed-bin
 * latency histogram — fed by the same `onResponse` hook as the OTel metrics
 * (see `request-tracing.ts`). It backs `GET /api/v1/stats/traffic` and the
 * dashboard charts without requiring an external observability stack.
 *
 * A short ring of recent error responses (4xx/5xx) is kept alongside for the
 * dashboard's "Recent Errors" list. Everything here is ephemeral and
 * per-process — for durable history, operators point Prometheus/Grafana at
 * `/metrics` as before.
 */

// --- Types -----------------------------------------------------------

export type TrafficPeriod = '1h' | '6h' | '24h' | '7d';

export interface TrafficSample {
  durationMs: number;
  statusCode: number;
  /** Surface label from `surfaceForPath` (rest | graphql | mcp | …). */
  surface: string;
  method: string;
  path: string;
}

export interface TrafficPoint {
  /** Bucket start, ISO 8601. */
  timestamp: string;
  total: number;
  errors: number;
  bySurface: Record<string, number>;
}

export interface TrafficSummary {
  period: TrafficPeriod;
  bucketMinutes: number;
  points: TrafficPoint[];
  totals: { requests: number; errors: number };
  latency: { p50: number; p95: number; p99: number };
}

export interface ErrorEntry {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  surface: string;
}

// --- Internals -------------------------------------------------------

/** Upper bounds (ms) of the latency histogram bins; last bin is +Inf. */
const LATENCY_BOUNDS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const MINUTES_KEPT = 7 * 24 * 60; // one week of minute buckets
const MAX_RECENT_ERRORS = 100;

/** Display resolution per period: enough points to chart, small payloads. */
const PERIOD_CONFIG: Record<TrafficPeriod, { minutes: number; bucketMinutes: number }> = {
  '1h': { minutes: 60, bucketMinutes: 1 },
  '6h': { minutes: 360, bucketMinutes: 5 },
  '24h': { minutes: 1440, bucketMinutes: 15 },
  '7d': { minutes: 10080, bucketMinutes: 60 },
};

interface MinuteBucket {
  /** Epoch minute (unix ms / 60000). */
  minute: number;
  total: number;
  errors: number;
  bySurface: Map<string, number>;
  latencyBins: number[];
}

function newBucket(minute: number): MinuteBucket {
  return {
    minute,
    total: 0,
    errors: 0,
    bySurface: new Map(),
    latencyBins: new Array(LATENCY_BOUNDS.length + 1).fill(0),
  };
}

function binFor(durationMs: number): number {
  for (let i = 0; i < LATENCY_BOUNDS.length; i++) {
    const bound = LATENCY_BOUNDS[i];
    if (bound !== undefined && durationMs <= bound) return i;
  }
  return LATENCY_BOUNDS.length;
}

/** Approximate percentile from histogram bins (upper bound of the bin hit). */
function percentileFromBins(bins: number[], percentile: number): number {
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  const target = Math.ceil((percentile / 100) * total);
  let seen = 0;
  for (let i = 0; i < bins.length; i++) {
    seen += bins[i] ?? 0;
    if (seen >= target) return LATENCY_BOUNDS[i] ?? LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1] ?? 0;
  }
  return LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1] ?? 0;
}

// --- TrafficStats ----------------------------------------------------

export class TrafficStats {
  private buckets = new Map<number, MinuteBucket>();
  private recentErrors: ErrorEntry[] = [];

  /** Records one completed HTTP request. Called from the tracing hook. */
  record(sample: TrafficSample, now = Date.now()): void {
    const minute = Math.floor(now / 60_000);
    let bucket = this.buckets.get(minute);
    if (!bucket) {
      bucket = newBucket(minute);
      this.buckets.set(minute, bucket);
      this.evict(minute);
    }
    bucket.total += 1;
    bucket.bySurface.set(sample.surface, (bucket.bySurface.get(sample.surface) ?? 0) + 1);
    const bin = binFor(sample.durationMs);
    bucket.latencyBins[bin] = (bucket.latencyBins[bin] ?? 0) + 1;

    if (sample.statusCode >= 400) {
      bucket.errors += 1;
      this.recentErrors.push({
        timestamp: new Date(now).toISOString(),
        method: sample.method,
        path: sample.path,
        status: sample.statusCode,
        surface: sample.surface,
      });
      if (this.recentErrors.length > MAX_RECENT_ERRORS) {
        this.recentErrors.splice(0, this.recentErrors.length - MAX_RECENT_ERRORS);
      }
    }
  }

  /** Aggregates the ring buffer into chartable points for a period. */
  query(period: TrafficPeriod, now = Date.now()): TrafficSummary {
    const { minutes, bucketMinutes } = PERIOD_CONFIG[period];
    const endMinute = Math.floor(now / 60_000) + 1; // include the current minute
    const startMinute = endMinute - minutes;

    const pointCount = minutes / bucketMinutes;
    const points: TrafficPoint[] = [];
    const latencyBins = new Array(LATENCY_BOUNDS.length + 1).fill(0);
    let requests = 0;
    let errors = 0;

    for (let p = 0; p < pointCount; p++) {
      const pointStart = startMinute + p * bucketMinutes;
      const point: TrafficPoint = {
        timestamp: new Date(pointStart * 60_000).toISOString(),
        total: 0,
        errors: 0,
        bySurface: {},
      };
      for (let m = pointStart; m < pointStart + bucketMinutes; m++) {
        const bucket = this.buckets.get(m);
        if (!bucket) continue;
        point.total += bucket.total;
        point.errors += bucket.errors;
        for (const [surface, count] of bucket.bySurface) {
          point.bySurface[surface] = (point.bySurface[surface] ?? 0) + count;
        }
        for (let i = 0; i < bucket.latencyBins.length; i++) {
          latencyBins[i] += bucket.latencyBins[i] ?? 0;
        }
      }
      requests += point.total;
      errors += point.errors;
      points.push(point);
    }

    return {
      period,
      bucketMinutes,
      points,
      totals: { requests, errors },
      latency: {
        p50: percentileFromBins(latencyBins, 50),
        p95: percentileFromBins(latencyBins, 95),
        p99: percentileFromBins(latencyBins, 99),
      },
    };
  }

  /** Request/error totals over the trailing 24 hours (for the stats snapshot). */
  totals24h(now = Date.now()): { requests: number; errors: number } {
    const { totals } = this.query('24h', now);
    return totals;
  }

  /** Most recent 4xx/5xx responses, newest first. */
  errors(limit = 10): ErrorEntry[] {
    return this.recentErrors.slice(-Math.max(1, limit)).reverse();
  }

  /** Drops all recorded data (tests). */
  reset(): void {
    this.buckets.clear();
    this.recentErrors = [];
  }

  private evict(currentMinute: number): void {
    const oldest = currentMinute - MINUTES_KEPT;
    for (const minute of this.buckets.keys()) {
      if (minute < oldest) this.buckets.delete(minute);
    }
  }
}

// --- Module-level singleton ------------------------------------------

/**
 * Shared instance used by the request-tracing hook and the stats routes.
 * Module-level (like the instruments in `metrics.ts`) because the tracing
 * hook has no service container to resolve from.
 */
export const trafficStats = new TrafficStats();
