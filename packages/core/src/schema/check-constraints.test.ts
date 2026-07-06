/**
 * Unit tests for CHECK constraint rendering (Phase 10 — field constraints
 * become real Postgres constraints).
 */

import { describe, expect, it } from 'vitest';
import { buildCheckConstraints } from './check-constraints.js';

describe('buildCheckConstraints', () => {
  it('renders numeric min/max as value bounds', () => {
    const specs = buildCheckConstraints('deals', 'amount', 'decimal', { min: 0, max: 1000000 });
    expect(specs).toEqual([
      { name: 'ion_ck_deals_amount_min', kind: 'min', expression: '"amount" >= 0' },
      { name: 'ion_ck_deals_amount_max', kind: 'max', expression: '"amount" <= 1000000' },
    ]);
  });

  it('renders text min/max as char_length bounds', () => {
    const specs = buildCheckConstraints('contacts', 'name', 'short_text', { min: 2, max: 80 });
    expect(specs.map((s) => s.expression)).toEqual([
      'char_length("name") >= 2',
      'char_length("name") <= 80',
    ]);
  });

  it('renders pattern as a regex match with escaped quotes', () => {
    const specs = buildCheckConstraints('contacts', 'code', 'short_text', {
      pattern: "^[A-Z]+'s$",
    });
    expect(specs[0]?.expression).toBe(`"code" ~ '^[A-Z]+''s$'`);
  });

  it('renders single-select enums as IN lists', () => {
    const specs = buildCheckConstraints('deals', 'stage', 'enum', {
      enumValues: ['lead', 'won', "o'brien"],
    });
    expect(specs[0]?.expression).toBe(`"stage" IN ('lead', 'won', 'o''brien')`);
    expect(specs[0]?.name).toBe('ion_ck_deals_stage_enum');
  });

  it('renders multi-select enums as array containment', () => {
    const specs = buildCheckConstraints('posts', 'tags', 'multi_enum', {
      enumValues: ['a', 'b'],
    });
    expect(specs[0]?.expression).toBe(`"tags" <@ ARRAY['a', 'b']::TEXT[]`);
  });

  it('skips constraint kinds that do not apply to the type', () => {
    // pattern on a number, min/max on a boolean — nothing to enforce
    expect(buildCheckConstraints('t', 'n', 'integer', { pattern: '^x$' })).toEqual([]);
    expect(buildCheckConstraints('t', 'b', 'boolean', { min: 1, max: 2 })).toEqual([]);
  });

  it('returns nothing without constraints', () => {
    expect(buildCheckConstraints('t', 'c', 'text', undefined)).toEqual([]);
    expect(buildCheckConstraints('t', 'c', 'text', {})).toEqual([]);
  });

  it('applies rating min/max as value bounds (special category)', () => {
    const specs = buildCheckConstraints('reviews', 'stars', 'rating', { min: 1, max: 5 });
    expect(specs.map((s) => s.expression)).toEqual(['"stars" >= 1', '"stars" <= 5']);
  });
});
