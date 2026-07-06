/**
 * Unit tests for the in-memory traffic aggregation (Phase 8, stats surface).
 *
 * Covers bucket accumulation, per-surface counts, error tracking, percentile
 * approximation, period aggregation, and the recent-errors ring.
 */

import { describe, expect, it } from 'vitest';
import { type TrafficSample, TrafficStats } from './traffic-stats.js';

const NOW = Date.UTC(2026, 6, 5, 12, 0, 30); // fixed clock for determinism

function sample(overrides: Partial<TrafficSample> = {}): TrafficSample {
  return {
    durationMs: 12,
    statusCode: 200,
    surface: 'rest',
    method: 'GET',
    path: '/api/v1/data/contacts',
    ...overrides,
  };
}

describe('TrafficStats', () => {
  it('accumulates request totals per surface', () => {
    const stats = new TrafficStats();
    stats.record(sample(), NOW);
    stats.record(sample({ surface: 'graphql' }), NOW);
    stats.record(sample(), NOW);

    const summary = stats.query('1h', NOW);
    expect(summary.totals.requests).toBe(3);
    const last = summary.points[summary.points.length - 1];
    expect(last?.bySurface.rest).toBe(2);
    expect(last?.bySurface.graphql).toBe(1);
  });

  it('counts 4xx/5xx as errors and keeps a recent-errors ring', () => {
    const stats = new TrafficStats();
    stats.record(sample({ statusCode: 404, path: '/api/v1/data/missing' }), NOW);
    stats.record(sample({ statusCode: 500, method: 'POST' }), NOW);
    stats.record(sample(), NOW);

    expect(stats.query('1h', NOW).totals.errors).toBe(2);
    const errors = stats.errors(10);
    expect(errors).toHaveLength(2);
    // Newest first.
    expect(errors[0]?.status).toBe(500);
    expect(errors[1]?.path).toBe('/api/v1/data/missing');
  });

  it('approximates latency percentiles from histogram bins', () => {
    const stats = new TrafficStats();
    for (let i = 0; i < 98; i++) stats.record(sample({ durationMs: 8 }), NOW);
    stats.record(sample({ durationMs: 900 }), NOW);
    stats.record(sample({ durationMs: 4000 }), NOW);

    const { latency } = stats.query('1h', NOW);
    expect(latency.p50).toBeLessThanOrEqual(10);
    expect(latency.p99).toBeGreaterThanOrEqual(900);
  });

  it('aggregates minute buckets into the period resolution', () => {
    const stats = new TrafficStats();
    // One request 10 minutes ago, one now → distinct 5-minute points on 6h.
    stats.record(sample(), NOW - 10 * 60_000);
    stats.record(sample(), NOW);

    const summary = stats.query('6h', NOW);
    expect(summary.bucketMinutes).toBe(5);
    expect(summary.points).toHaveLength(72);
    expect(summary.totals.requests).toBe(2);
    const nonEmpty = summary.points.filter((p) => p.total > 0);
    expect(nonEmpty).toHaveLength(2);
  });

  it('excludes samples outside the queried period', () => {
    const stats = new TrafficStats();
    stats.record(sample(), NOW - 2 * 60 * 60_000); // two hours ago
    stats.record(sample(), NOW);

    expect(stats.query('1h', NOW).totals.requests).toBe(1);
    expect(stats.query('6h', NOW).totals.requests).toBe(2);
    expect(stats.totals24h(NOW).requests).toBe(2);
  });

  it('resets cleanly', () => {
    const stats = new TrafficStats();
    stats.record(sample({ statusCode: 500 }), NOW);
    stats.reset();
    expect(stats.query('1h', NOW).totals.requests).toBe(0);
    expect(stats.errors()).toHaveLength(0);
  });
});
