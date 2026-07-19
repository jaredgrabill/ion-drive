/**
 * Unit tests for the anonymous (guest) auth support (issue #6): email-domain
 * derivation, cleanup-config parsing, and — via a never-connected pg.Pool —
 * the config gating of the Better Auth `anonymous` plugin (endpoint present
 * only when the option is passed).
 */

import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_CLEANUP_DEFAULT_MAX_AGE_DAYS,
  deriveEmailDomain,
  resolveCleanupMaxAgeDays,
} from './anonymous.js';
import { BetterAuthProvider } from './better-auth-adapter.js';

describe('deriveEmailDomain', () => {
  it('returns the hostname of a URL', () => {
    expect(deriveEmailDomain('https://api.example.com')).toBe('api.example.com');
  });

  it('strips port and path', () => {
    expect(deriveEmailDomain('http://localhost:3000/base')).toBe('localhost');
  });

  it('returns undefined for an unparsable URL', () => {
    expect(deriveEmailDomain('not a url')).toBeUndefined();
  });
});

describe('resolveCleanupMaxAgeDays', () => {
  it('accepts a positive number', () => {
    expect(resolveCleanupMaxAgeDays({ maxAgeDays: 7 })).toBe(7);
  });

  it('accepts a numeric string', () => {
    expect(resolveCleanupMaxAgeDays({ maxAgeDays: '14' })).toBe(14);
  });

  it.each([[0], [-3], ['nope'], [null], [undefined]])(
    'falls back to the default for %j',
    (value) => {
      expect(resolveCleanupMaxAgeDays({ maxAgeDays: value })).toBe(
        ANONYMOUS_CLEANUP_DEFAULT_MAX_AGE_DAYS,
      );
    },
  );

  it('falls back to the default when config is missing', () => {
    expect(resolveCleanupMaxAgeDays(undefined)).toBe(ANONYMOUS_CLEANUP_DEFAULT_MAX_AGE_DAYS);
  });
});

describe('BetterAuthProvider anonymous gating', () => {
  /** A pool that is never connected — betterAuth() only touches it on use. */
  const pool = () => new pg.Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/x' });

  const baseOptions = {
    secret: 'test-secret-test-secret-test-secret!',
    baseURL: 'http://localhost:3000',
  };

  it('does not expose the anonymous endpoint by default (flag off)', () => {
    const provider = new BetterAuthProvider({ ...baseOptions, pool: pool() });
    expect((provider.auth.api as Record<string, unknown>).signInAnonymous).toBeUndefined();
  });

  it('exposes the anonymous endpoint when the anonymous option is set', () => {
    const provider = new BetterAuthProvider({
      ...baseOptions,
      pool: pool(),
      anonymous: { emailDomainName: 'example.com' },
    });
    expect(typeof (provider.auth.api as Record<string, unknown>).signInAnonymous).toBe('function');
  });
});
