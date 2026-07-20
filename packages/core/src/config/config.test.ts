/**
 * Tests for config loading — focused on the hardening knobs added in
 * Phase 14's warm-up (trustProxy parsing, metrics token, signup lockout).
 * Values are driven through process.env so the env-var mapping is covered too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type IonDriveConfig, loadConfig, parseEnvBool } from './index.js';

/** Every strict-boolean flag: env var → config key + default (issue #25). */
const BOOL_FLAGS = [
  ['ION_REQUIRE_AUTH', 'requireAuth', false],
  ['ION_ALLOW_OPEN', 'allowOpen', false],
  ['ION_PUBLIC_ROLE', 'publicRole', true],
  ['ION_DISABLE_SIGNUP', 'disableSignup', false],
  ['ION_ANONYMOUS_AUTH', 'anonymousAuth', false],
  ['ION_RATE_LIMIT_ENABLED', 'rateLimitEnabled', true],
  ['ION_OTEL_ENABLED', 'otelEnabled', false],
  ['ION_OTEL_TRACES_ENABLED', 'otelTracesEnabled', true],
  ['ION_OTEL_LOGS_ENABLED', 'otelLogsEnabled', false],
  ['ION_METRICS_ENABLED', 'metricsEnabled', true],
  ['ION_OTEL_METRICS_ENABLED', 'otelMetricsEnabled', false],
  ['ION_TASKS_ENABLED', 'tasksEnabled', true],
  ['ION_ADMIN_ENABLED', 'adminEnabled', true],
  ['ION_BLOCKS_ENABLED', 'blocksEnabled', true],
  ['ION_EVENTS_ENABLED', 'eventsEnabled', true],
] as const satisfies ReadonlyArray<readonly [string, keyof IonDriveConfig, boolean]>;

const ENV_KEYS = [
  'ION_TRUST_PROXY',
  'ION_METRICS_TOKEN',
  'ION_ADMIN_EMAIL',
  'ION_ADMIN_PASSWORD',
  'ION_ADMIN_PASSWORD_FILE',
  ...BOOL_FLAGS.map(([envVar]) => envVar),
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

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

describe('strict boolean env parsing (issue #25)', () => {
  it('preserves every flag default when the variable is unset', () => {
    const config = loadConfig();
    for (const [envVar, key, dflt] of BOOL_FLAGS) {
      expect(config[key], `${envVar} default`).toBe(dflt);
    }
  });

  // The issue's headline: "false" is FALSE now. Every flag, both polarities —
  // catches any stragglers on z.coerce.boolean (which read "false" as true).
  it.each(BOOL_FLAGS)('%s: "false" disables and "true" enables', (envVar, key) => {
    process.env[envVar] = 'false';
    expect(loadConfig()[key]).toBe(false);
    process.env[envVar] = 'true';
    expect(loadConfig()[key]).toBe(true);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['True', true],
    ['1', true],
    ['yes', true],
    ['YES', true],
    ['on', true],
    ['  on  ', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['OFF', false],
    ['  off  ', false],
    ['', false],
  ] as const)('parses ION_OTEL_ENABLED=%j as %j', (raw, expected) => {
    process.env.ION_OTEL_ENABLED = raw;
    expect(loadConfig().otelEnabled).toBe(expected);
  });

  it.each(['maybe', 'enabled', '2', 'ja', 'null', 'undefined', 'fals'])(
    'rejects ION_OTEL_ENABLED=%j at boot',
    (raw) => {
      process.env.ION_OTEL_ENABLED = raw;
      expect(() => loadConfig()).toThrow(/Invalid Ion Drive configuration/);
    },
  );

  it('names the variable and the accepted values in the rejection', () => {
    process.env.ION_ANONYMOUS_AUTH = 'maybe';
    let message = '';
    try {
      loadConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('ION_ANONYMOUS_AUTH');
    expect(message).toContain('"maybe"');
    expect(message).toContain('true, 1, yes, on');
    expect(message).toContain('false, 0, no, off');
  });

  it('reports every bad boolean at once, each under its own name', () => {
    process.env.ION_OTEL_ENABLED = 'nope!';
    process.env.ION_TASKS_ENABLED = 'yep!';
    let message = '';
    try {
      loadConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('ION_OTEL_ENABLED');
    expect(message).toContain('ION_TASKS_ENABLED');
  });

  it('parseEnvBool mirrors the schema for non-config call sites', () => {
    expect(parseEnvBool('ION_X', undefined, true)).toBe(true);
    expect(parseEnvBool('ION_X', undefined, false)).toBe(false);
    expect(parseEnvBool('ION_X', 'YES', false)).toBe(true);
    expect(parseEnvBool('ION_X', 'off', true)).toBe(false);
    expect(() => parseEnvBool('ION_X', 'garbage', false)).toThrow(/ION_X.*"garbage"/);
  });
});

describe('admin bootstrap config (issue #26)', () => {
  it('leaves signup open by default when no bootstrap variable is set', () => {
    const config = loadConfig();
    expect(config.adminEmail).toBeUndefined();
    expect(config.adminPassword).toBeUndefined();
    expect(config.adminPasswordFile).toBeUndefined();
    expect(config.disableSignup).toBe(false);
  });

  it.each([
    ['ION_ADMIN_EMAIL', 'ops@example.com'],
    ['ION_ADMIN_PASSWORD', 'a-long-password'],
    ['ION_ADMIN_PASSWORD_FILE', '/run/secrets/pw'],
  ] as const)('locks signup by default when %s is set', (envVar, value) => {
    process.env[envVar] = value;
    expect(loadConfig().disableSignup).toBe(true);
  });

  it('lets an explicit ION_DISABLE_SIGNUP=false keep signup open despite bootstrap vars', () => {
    process.env.ION_ADMIN_EMAIL = 'ops@example.com';
    process.env.ION_ADMIN_PASSWORD = 'a-long-password';
    process.env.ION_DISABLE_SIGNUP = 'false';
    expect(loadConfig().disableSignup).toBe(false);
  });

  it('lets a programmatic override keep signup open despite bootstrap vars', () => {
    process.env.ION_ADMIN_EMAIL = 'ops@example.com';
    expect(loadConfig({ disableSignup: false }).disableSignup).toBe(false);
  });

  it('maps the ION_ADMIN_* variables and validates the email shape', () => {
    process.env.ION_ADMIN_EMAIL = 'ops@example.com';
    process.env.ION_ADMIN_PASSWORD = 'a-long-password';
    const config = loadConfig();
    expect(config.adminEmail).toBe('ops@example.com');
    expect(config.adminPassword).toBe('a-long-password');

    process.env.ION_ADMIN_EMAIL = 'not-an-email';
    expect(() => loadConfig()).toThrow(/adminEmail/);
  });
});
