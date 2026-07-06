/**
 * Grid-types tests — cell-kind resolution, operator sets, and query-string
 * serialization against the Phase 7 REST syntax.
 */

import { describe, expect, it } from 'vitest';
import { buildQueryString, cellKindOf, operatorsFor } from './grid-types';

describe('cellKindOf', () => {
  it('maps backend column types to cell kinds', () => {
    expect(cellKindOf('text')).toBe('text');
    expect(cellKindOf('long_text')).toBe('longText');
    expect(cellKindOf('integer')).toBe('number');
    expect(cellKindOf('currency')).toBe('currency');
    expect(cellKindOf('boolean')).toBe('boolean');
    expect(cellKindOf('datetime')).toBe('datetime');
    expect(cellKindOf('json')).toBe('json');
    expect(cellKindOf('uuid')).toBe('uuid');
  });

  it('defaults unknown types to text', () => {
    expect(cellKindOf('geo_point')).toBe('text');
  });
});

describe('operatorsFor', () => {
  it('gives text kinds contains/in/null operators', () => {
    const ops = operatorsFor('text').map((o) => o.op);
    expect(ops).toContain('contains');
    expect(ops).toContain('in');
    expect(ops).toContain('null');
  });

  it('gives numeric kinds comparison operators', () => {
    const ops = operatorsFor('number').map((o) => o.op);
    expect(ops).toEqual(expect.arrayContaining(['gt', 'gte', 'lt', 'lte']));
  });

  it('restricts booleans to is/empty', () => {
    expect(operatorsFor('boolean').map((o) => o.op)).toEqual(['eq', 'null']);
  });
});

describe('buildQueryString', () => {
  const base = { page: 1, pageSize: 25, search: '', filters: [], sorts: [] };

  it('always includes pagination', () => {
    expect(buildQueryString(base)).toBe('?page=1&pageSize=25');
  });

  it('serializes search as q=', () => {
    expect(buildQueryString({ ...base, search: 'ada' })).toContain('q=ada');
  });

  it('serializes sorts with - prefix for desc', () => {
    const qs = buildQueryString({
      ...base,
      sorts: [
        { field: 'name', direction: 'asc' },
        { field: 'created_at', direction: 'desc' },
      ],
    });
    expect(qs).toContain(`sort=${encodeURIComponent('name,-created_at')}`);
  });

  it('serializes filters as field[op]=value', () => {
    const qs = buildQueryString({
      ...base,
      filters: [{ field: 'age', op: 'gte', value: '21' }],
    });
    expect(decodeURIComponent(qs)).toContain('age[gte]=21');
  });

  it('skips filters with no field or operator', () => {
    const qs = buildQueryString({
      ...base,
      filters: [{ field: '', op: 'eq', value: 'x' }],
    });
    expect(qs).toBe('?page=1&pageSize=25');
  });
});
