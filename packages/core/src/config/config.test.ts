/**
 * Tests for config loading — focused on the hardening knobs added in
 * Phase 14's warm-up (trustProxy parsing, metrics token, signup lockout).
 * Values are driven through process.env so the env-var mapping is covered too.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const ENV_KEYS = [
  'ION_TRUST_PROXY',
  'ION_DISABLE_SIGNUP',
  'ION_METRICS_TOKEN',
  'ION_REQUIRE_AUTH',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('loadConfig hardening knobs', () => {
  it('defaults: trustProxy off, signup open, no metrics token', () => {
    const config = loadConfig();
    expect(config.trustProxy).toBe(false);
    expect(config.disableSignup).toBe(false);
    expect(config.metricsToken).toBeUndefined();
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['on', true],
    ['false', false],
    ['off', false],
  ] as const)('parses ION_TRUST_PROXY=%j as %j', (raw, expected) => {
    process.env.ION_TRUST_PROXY = raw;
    expect(loadConfig().trustProxy).toBe(expected);
  });

  it('parses a numeric ION_TRUST_PROXY as a hop count', () => {
    process.env.ION_TRUST_PROXY = '2';
    expect(loadConfig().trustProxy).toBe(2);
  });

  it('passes an ION_TRUST_PROXY address list through verbatim', () => {
    process.env.ION_TRUST_PROXY = '127.0.0.1,10.0.0.0/8';
    expect(loadConfig().trustProxy).toBe('127.0.0.1,10.0.0.0/8');
  });

  it.each([
    ['true', true],
    ['false', false],
    ['0', false],
  ] as const)('parses ION_DISABLE_SIGNUP=%j as %j', (raw, expected) => {
    process.env.ION_DISABLE_SIGNUP = raw;
    expect(loadConfig().disableSignup).toBe(expected);
  });

  // Regression (launch-plan Lane 0): requireAuth was parsed with
  // z.coerce.boolean(), which treats every non-empty string — including
  // "false" — as true, silently ignoring the documented off switch.
  it.each([
    ['true', true],
    ['false', false],
    ['0', false],
    ['off', false],
  ] as const)('parses ION_REQUIRE_AUTH=%j as %j', (raw, expected) => {
    process.env.ION_REQUIRE_AUTH = raw;
    expect(loadConfig().requireAuth).toBe(expected);
  });

  it('accepts ION_METRICS_TOKEN', () => {
    process.env.ION_METRICS_TOKEN = 'scrape-me';
    expect(loadConfig().metricsToken).toBe('scrape-me');
  });
});
