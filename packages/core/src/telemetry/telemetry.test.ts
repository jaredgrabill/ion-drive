import { describe, expect, it } from 'vitest';
import { recordHttpRequest, recordSchemaChange, recordTaskRun } from './metrics.js';
import { ION_ATTR, surfaceForPath } from './span-attributes.js';

describe('surfaceForPath', () => {
  it('classifies each API surface', () => {
    expect(surfaceForPath('/api/v1/data/contacts')).toBe('rest');
    expect(surfaceForPath('/api/v1/graphql')).toBe('graphql');
    expect(surfaceForPath('/api/v1/mcp')).toBe('mcp');
    expect(surfaceForPath('/api/v1/schema/objects')).toBe('schema');
    expect(surfaceForPath('/api/auth/sign-in')).toBe('auth');
    expect(surfaceForPath('/api/v1/roles')).toBe('admin');
    expect(surfaceForPath('/health')).toBe('other');
  });
});

describe('metric helpers', () => {
  // With no MeterProvider installed the OTel API returns no-op instruments;
  // these calls must never throw so callers need no telemetry-enabled guard.
  it('are safe no-ops when telemetry is disabled', () => {
    expect(() => recordHttpRequest(12.3, { [ION_ATTR.SURFACE]: 'rest' })).not.toThrow();
    expect(() => recordSchemaChange('create_object', 'contacts')).not.toThrow();
    expect(() => recordTaskRun(5, { [ION_ATTR.OUTCOME]: 'success' })).not.toThrow();
  });
});
