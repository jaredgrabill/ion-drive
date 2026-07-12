/**
 * Unit tests for the boot-time / runtime security advisories (audit V6 / V7).
 */

import { describe, expect, it } from 'vitest';
import {
  type AdvisoryConfig,
  collectBootAdvisories,
  isUntrustedForwardedFor,
} from './security-advisories.js';

const base: AdvisoryConfig = {
  metricsEnabled: true,
  metricsToken: 'a-token',
  nodeEnv: 'production',
  trustProxy: false,
};

describe('collectBootAdvisories (V6)', () => {
  it('is silent for a hardened production config', () => {
    expect(collectBootAdvisories(base)).toEqual([]);
  });

  it('warns when /metrics is open (enabled + no token)', () => {
    const out = collectBootAdvisories({ ...base, metricsToken: undefined });
    expect(out.some((m) => m.includes('/metrics'))).toBe(true);
  });

  it('does not warn about metrics when the endpoint is disabled', () => {
    const out = collectBootAdvisories({
      ...base,
      metricsEnabled: false,
      metricsToken: undefined,
    });
    expect(out.some((m) => m.includes('/metrics'))).toBe(false);
  });

  it('warns about the CSP/verbose-logging posture outside production', () => {
    const out = collectBootAdvisories({ ...base, nodeEnv: 'development' });
    expect(out.some((m) => m.includes('NODE_ENV=production'))).toBe(true);
  });
});

describe('isUntrustedForwardedFor (V7)', () => {
  it('warns when XFF is present and trustProxy is false', () => {
    expect(isUntrustedForwardedFor(false, { 'x-forwarded-for': '203.0.113.7' })).toBe(true);
  });

  it('is quiet when no XFF header is present', () => {
    expect(isUntrustedForwardedFor(false, {})).toBe(false);
  });

  it('is quiet when a proxy is configured (hop count or CIDR)', () => {
    expect(isUntrustedForwardedFor(1, { 'x-forwarded-for': '203.0.113.7' })).toBe(false);
    expect(isUntrustedForwardedFor('10.0.0.0/8', { 'x-forwarded-for': '203.0.113.7' })).toBe(false);
    expect(isUntrustedForwardedFor(true, { 'x-forwarded-for': '203.0.113.7' })).toBe(false);
  });
});
