/**
 * Unit tests for the Phase 10 compatible-type matrix — the decision table
 * behind `SchemaManager.modifyField`'s type changes.
 */

import { describe, expect, it } from 'vitest';
import { assessTypeChange, textLimit } from './type-compat.js';

describe('textLimit', () => {
  it('reads VARCHAR limits from the declared PG type', () => {
    expect(textLimit('short_text')).toBe(255);
    expect(textLimit('email')).toBe(320);
    expect(textLimit('color')).toBe(7);
  });

  it('returns null for unlimited TEXT types', () => {
    expect(textLimit('text')).toBeNull();
    expect(textLimit('long_text')).toBeNull();
  });
});

describe('assessTypeChange — text family', () => {
  it('treats widening as safe (short_text → text)', () => {
    const result = assessTypeChange('short_text', 'text');
    expect(result).toMatchObject({ compatible: true, level: 'safe' });
  });

  it('warns and demands a length pre-check when narrowing (text → short_text)', () => {
    const result = assessTypeChange('text', 'short_text');
    expect(result).toMatchObject({
      compatible: true,
      level: 'warn',
      precheck: { kind: 'max_text_length', limit: 255 },
    });
  });

  it('treats equal-limit relabels as safe (slug ↔ short_text, enum → short_text)', () => {
    expect(assessTypeChange('slug', 'short_text')).toMatchObject({ level: 'safe' });
    expect(assessTypeChange('enum', 'short_text')).toMatchObject({ level: 'safe' });
  });
});

describe('assessTypeChange — numbers', () => {
  it('widens safely (integer → big_integer, integer → decimal, rating → integer)', () => {
    expect(assessTypeChange('integer', 'big_integer')).toMatchObject({ level: 'safe' });
    expect(assessTypeChange('integer', 'decimal')).toMatchObject({ level: 'safe' });
    expect(assessTypeChange('rating', 'integer')).toMatchObject({ level: 'safe' });
  });

  it('warns with a range pre-check when narrowing (big_integer → integer)', () => {
    const result = assessTypeChange('big_integer', 'integer');
    expect(result).toMatchObject({
      compatible: true,
      level: 'warn',
      precheck: { kind: 'numeric_range', min: -2147483648, max: 2147483647 },
    });
  });

  it('warns about rounding when dropping fractional digits (decimal → integer)', () => {
    const result = assessTypeChange('decimal', 'integer');
    expect(result).toMatchObject({ compatible: true, level: 'warn' });
    expect(result.compatible && result.message).toContain('rounded');
  });

  it('supplies a USING cast for numeric conversions', () => {
    const result = assessTypeChange('integer', 'big_integer');
    expect(result.compatible && result.usingCast).toBe('::BIGINT');
  });
});

describe('assessTypeChange — cross-family', () => {
  it('renders numbers/uuids to text safely with an explicit cast', () => {
    expect(assessTypeChange('integer', 'text')).toMatchObject({
      level: 'safe',
      usingCast: '::TEXT',
    });
    expect(assessTypeChange('uuid', 'text')).toMatchObject({ level: 'safe' });
  });

  it('pre-checks length when rendering into a tightly limited text type', () => {
    const result = assessTypeChange('json', 'short_text');
    expect(result).toMatchObject({
      compatible: true,
      level: 'warn',
      precheck: { kind: 'max_text_length', limit: 255 },
    });
  });

  it('widens date → datetime safely, warns on datetime → date', () => {
    expect(assessTypeChange('date', 'datetime')).toMatchObject({ level: 'safe' });
    expect(assessTypeChange('datetime', 'date')).toMatchObject({ level: 'warn' });
  });

  it('relabels multi_enum ↔ array_text safely (same physical type)', () => {
    expect(assessTypeChange('multi_enum', 'array_text')).toMatchObject({ level: 'safe' });
    expect(assessTypeChange('array_text', 'multi_enum')).toMatchObject({ level: 'safe' });
  });

  it('hard-errors incompatible pairs (text → integer, boolean → date)', () => {
    expect(assessTypeChange('text', 'integer').compatible).toBe(false);
    expect(assessTypeChange('boolean', 'date').compatible).toBe(false);
    expect(assessTypeChange('json', 'integer').compatible).toBe(false);
  });

  it('is a safe no-op for identical types', () => {
    expect(assessTypeChange('text', 'text')).toMatchObject({ compatible: true, level: 'safe' });
  });
});
