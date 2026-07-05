/**
 * Unit tests for DEFAULT expression rendering — the fix that lets literal
 * defaults (e.g. an enum's `lead`) coexist with SQL expressions (`NOW()`).
 */

import { describe, expect, it } from 'vitest';
import { renderDefaultExpression } from './ddl-executor.js';

describe('renderDefaultExpression', () => {
  it('quotes bare string literals', () => {
    expect(renderDefaultExpression('lead')).toBe("'lead'");
    expect(renderDefaultExpression('note')).toBe("'note'");
  });

  it('passes SQL function calls through untouched', () => {
    expect(renderDefaultExpression('gen_random_uuid()')).toBe('gen_random_uuid()');
    expect(renderDefaultExpression('NOW()')).toBe('NOW()');
  });

  it('passes keywords and numbers through untouched', () => {
    expect(renderDefaultExpression('false')).toBe('false');
    expect(renderDefaultExpression('TRUE')).toBe('TRUE');
    expect(renderDefaultExpression('null')).toBe('null');
    expect(renderDefaultExpression('0')).toBe('0');
    expect(renderDefaultExpression('12.5')).toBe('12.5');
    expect(renderDefaultExpression('-3')).toBe('-3');
  });

  it('passes casts through and preserves already-quoted literals', () => {
    expect(renderDefaultExpression("'{}'::jsonb")).toBe("'{}'::jsonb");
    expect(renderDefaultExpression("'hello'")).toBe("'hello'");
  });

  it('escapes single quotes in literals', () => {
    expect(renderDefaultExpression("O'Brien")).toBe("'O''Brien'");
  });

  it('falls back to an empty string literal for blank/missing values', () => {
    expect(renderDefaultExpression('')).toBe("''");
    expect(renderDefaultExpression(null)).toBe("''");
    expect(renderDefaultExpression(undefined)).toBe("''");
  });
});
