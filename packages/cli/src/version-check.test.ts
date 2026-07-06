/** Tests for the CLI ↔ server version-skew guard (Phase 14 Tier 0). */

import { describe, expect, it } from 'vitest';
import { CLI_VERSION, versionSkewMessage } from './version-check.js';

describe('versionSkewMessage', () => {
  it('is silent when major.minor match (patch drift ok)', () => {
    expect(versionSkewMessage('0.2.0', '0.2.9')).toBeNull();
    expect(versionSkewMessage('1.4.2', '1.4.0')).toBeNull();
  });

  it('warns on minor skew', () => {
    expect(versionSkewMessage('0.2.0', '0.3.1')).toContain('CLI v0.2.0 ≠ server v0.3.1');
  });

  it('warns on major skew', () => {
    expect(versionSkewMessage('1.0.0', '2.0.0')).toContain('≠ server v2.0.0');
  });

  it('is silent when the server version is missing or unparsable', () => {
    expect(versionSkewMessage('0.2.0', undefined)).toBeNull();
    expect(versionSkewMessage('0.2.0', 'dev')).toBeNull();
  });

  it('exposes a semver-ish CLI_VERSION', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
