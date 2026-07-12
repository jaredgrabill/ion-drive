/**
 * Unit tests for the CORS safety resolver (audit V2). Verifies that a
 * wildcard/reflecting origin is refused with credentials enabled, that the
 * default is same-origin only, and that an explicit allowlist is honoured.
 */

import { describe, expect, it } from 'vitest';
import { resolveCorsOptions } from './cors-options.js';

describe('resolveCorsOptions', () => {
  it('defaults to same-origin only (origin:false) with credentials on', () => {
    expect(resolveCorsOptions({ corsOrigins: false })).toEqual({
      origin: false,
      credentials: true,
    });
  });

  it('honours a single explicit allowlist origin with credentials', () => {
    expect(resolveCorsOptions({ corsOrigins: 'https://app.example.com' })).toEqual({
      origin: 'https://app.example.com',
      credentials: true,
    });
  });

  it('honours a multi-origin allowlist with credentials', () => {
    const origins = ['https://app.example.com', 'https://admin.example.com'];
    expect(resolveCorsOptions({ corsOrigins: origins })).toEqual({
      origin: origins,
      credentials: true,
    });
  });

  it('refuses a reflecting origin (true) — the V2 CSRF hole', () => {
    expect(() => resolveCorsOptions({ corsOrigins: true })).toThrow(/reflects every origin/i);
  });

  it('refuses a literal wildcard string', () => {
    expect(() => resolveCorsOptions({ corsOrigins: '*' })).toThrow(/reflects every origin/i);
  });

  it('refuses an allowlist that contains a wildcard', () => {
    expect(() => resolveCorsOptions({ corsOrigins: ['https://app.example.com', '*'] })).toThrow(
      /reflects every origin/i,
    );
  });
});
