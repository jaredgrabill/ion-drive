import { describe, expect, it } from 'vitest';
import { parseQueryParams } from './query-parser.js';

describe('parseQueryParams', () => {
  it('parses a bare field as an equality filter with coerced value', () => {
    const { filters } = parseQueryParams({ age: '21' });
    expect(filters).toEqual([{ field: 'age', operator: 'eq', value: 21 }]);
  });

  it('parses the field[operator]=value syntax', () => {
    const { filters } = parseQueryParams({ 'name[ilike]': 'john', 'age[gte]': '18' });
    expect(filters).toContainEqual({ field: 'name', operator: 'ilike', value: 'john' });
    expect(filters).toContainEqual({ field: 'age', operator: 'gte', value: 18 });
  });

  it('splits comma-separated values for in/nin operators', () => {
    const { filters } = parseQueryParams({ 'status[in]': 'active, pending ' });
    expect(filters).toEqual([{ field: 'status', operator: 'in', value: ['active', 'pending'] }]);
  });

  it('ignores unknown operators', () => {
    const { filters } = parseQueryParams({ 'name[bogus]': 'x' });
    expect(filters).toEqual([]);
  });

  it('matches operators case-insensitively', () => {
    const { filters } = parseQueryParams({ 'name[NEQ]': 'John', 'age[GTE]': '18' });
    expect(filters).toContainEqual({ field: 'name', operator: 'neq', value: 'John' });
    expect(filters).toContainEqual({ field: 'age', operator: 'gte', value: 18 });
  });

  it('resolves operator aliases (ne, <>, >, contains, notin)', () => {
    expect(parseQueryParams({ 'a[ne]': '1' }).filters).toContainEqual({
      field: 'a',
      operator: 'neq',
      value: 1,
    });
    expect(parseQueryParams({ 'a[<>]': 'x' }).filters).toContainEqual({
      field: 'a',
      operator: 'neq',
      value: 'x',
    });
    expect(parseQueryParams({ 'a[>]': '5' }).filters).toContainEqual({
      field: 'a',
      operator: 'gt',
      value: 5,
    });
    expect(parseQueryParams({ 'name[contains]': 'jo' }).filters).toContainEqual({
      field: 'name',
      operator: 'ilike',
      value: 'jo',
    });
    expect(parseQueryParams({ 'status[notin]': 'a,b' }).filters).toContainEqual({
      field: 'status',
      operator: 'nin',
      value: ['a', 'b'],
    });
  });

  it('coerces numeric values inside in/nin lists', () => {
    const { filters } = parseQueryParams({ 'age[in]': '18, 21, 30' });
    expect(filters).toEqual([{ field: 'age', operator: 'in', value: [18, 21, 30] }]);
  });

  it('parses the search term and its q alias', () => {
    expect(parseQueryParams({ search: '  acme corp ' }).search).toBe('acme corp');
    expect(parseQueryParams({ q: 'widget' }).search).toBe('widget');
    expect(parseQueryParams({ search: '   ' }).search).toBeUndefined();
    expect(parseQueryParams({}).search).toBeUndefined();
  });

  it('does not treat search or q as filters', () => {
    const { filters } = parseQueryParams({ search: 'acme', q: 'x' });
    expect(filters).toEqual([]);
  });

  it('coerces boolean and null string values', () => {
    const { filters } = parseQueryParams({ active: 'true', deleted: 'false' });
    expect(filters).toContainEqual({ field: 'active', operator: 'eq', value: true });
    expect(filters).toContainEqual({ field: 'deleted', operator: 'eq', value: false });
  });

  it('parses sort with descending prefix', () => {
    const { sort } = parseQueryParams({ sort: 'name,-created_at' });
    expect(sort).toEqual([
      { field: 'name', direction: 'asc' },
      { field: 'created_at', direction: 'desc' },
    ]);
  });

  it('clamps pagination to the allowed range', () => {
    expect(parseQueryParams({ page: '0', pageSize: '9999' }).pagination).toEqual({
      page: 1,
      pageSize: 100,
    });
    expect(parseQueryParams({}).pagination).toEqual({ page: 1, pageSize: 25 });
  });

  it('parses offset-based limit/offset pagination', () => {
    const { pagination } = parseQueryParams({ limit: '10', offset: '20' });
    expect(pagination).toEqual({ page: 1, pageSize: 25, limit: 10, offset: 20 });
  });

  it('clamps limit to the max and floors offset at zero', () => {
    expect(parseQueryParams({ limit: '9999', offset: '-5' }).pagination).toMatchObject({
      limit: 100,
      offset: 0,
    });
  });

  it('omits limit/offset when not provided', () => {
    const { pagination } = parseQueryParams({ page: '2' });
    expect(pagination.limit).toBeUndefined();
    expect(pagination.offset).toBeUndefined();
  });

  it('does not treat limit/offset as filters', () => {
    expect(parseQueryParams({ limit: '10', offset: '0' }).filters).toEqual([]);
  });

  it('does not treat reserved keys as filters', () => {
    const { filters } = parseQueryParams({ sort: 'name', page: '2', expand: 'company' });
    expect(filters).toEqual([]);
  });
});
