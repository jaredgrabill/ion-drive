import { describe, expect, it } from 'vitest';
import { QueryBuilder, query } from './query-builder.js';

describe('QueryBuilder', () => {
  it('emits a bare field=value for eq', () => {
    expect(query().eq('status', 'active').toQueryString()).toBe('status=active');
  });

  it('emits field[op]=value for other operators', () => {
    const qs = query().neq('name', 'John').gt('created_at', '2020-10-10').toQueryString();
    // URLSearchParams encodes [] — decode for a readable assertion.
    expect(decodeURIComponent(qs)).toBe('name[neq]=John&created_at[gt]=2020-10-10');
  });

  it('normalises operator aliases', () => {
    expect(decodeURIComponent(query().where('a', 'ne', 1).toQueryString())).toBe('a[neq]=1');
    expect(decodeURIComponent(query().where('a', '>', 5).toQueryString())).toBe('a[gt]=5');
    expect(decodeURIComponent(query().where('n', 'contains', 'jo').toQueryString())).toBe(
      'n[ilike]=jo',
    );
  });

  it('joins in/nin arrays with commas', () => {
    expect(decodeURIComponent(query().in('status', ['a', 'b', 'c']).toQueryString())).toBe(
      'status[in]=a,b,c',
    );
  });

  it('emits a placeholder value for null operators', () => {
    expect(decodeURIComponent(query().isNull('deleted_at').toQueryString())).toBe(
      'deleted_at[is_null]=true',
    );
  });

  it('serialises Date values as ISO strings', () => {
    const d = new Date('2020-10-10T00:00:00.000Z');
    expect(decodeURIComponent(query().gte('created_at', d).toQueryString())).toBe(
      'created_at[gte]=2020-10-10T00:00:00.000Z',
    );
  });

  it('order() maps ascending option to sort direction', () => {
    expect(query().order('created_at', { ascending: false }).toQueryString()).toBe(
      'sort=-created_at',
    );
    expect(query().order('name').toQueryString()).toBe('sort=name');
    expect(query().order('name', 'desc').toQueryString()).toBe('sort=-name');
  });

  it('match() emits an equality filter per key', () => {
    const qs = query().match({ status: 'active', tier: 'gold' }).toQueryString();
    const params = new URLSearchParams(qs);
    expect(params.get('status')).toBe('active');
    expect(params.get('tier')).toBe('gold');
  });

  it('is(field, null) maps to is_null', () => {
    expect(decodeURIComponent(query().is('deleted_at', null).toQueryString())).toBe(
      'deleted_at[is_null]=true',
    );
  });

  it('not() maps supported negations', () => {
    expect(decodeURIComponent(query().not('status', 'eq', 'active').toQueryString())).toBe(
      'status[neq]=active',
    );
    expect(decodeURIComponent(query().not('tier', 'in', ['free']).toQueryString())).toBe(
      'tier[nin]=free',
    );
    expect(decodeURIComponent(query().not('deleted_at', 'is', null).toQueryString())).toBe(
      'deleted_at[is_not_null]=true',
    );
    expect(() => query().not('x', 'gt', 1)).toThrow(/not\(\) does not support/);
  });

  it('limit/offset/range emit offset-based paging params', () => {
    expect(query().limit(10).toQueryString()).toBe('limit=10');
    expect(new URLSearchParams(query().offset(5).limit(10).toQueryString()).get('offset')).toBe(
      '5',
    );
    const range = new URLSearchParams(query().range(20, 39).toQueryString());
    expect(range.get('offset')).toBe('20');
    expect(range.get('limit')).toBe('20');
  });

  it('select() accepts comma strings or separate fields', () => {
    expect(new URLSearchParams(query().select('id, full_name').toQueryString()).get('select')).toBe(
      'id,full_name',
    );
    expect(new URLSearchParams(query().select('id', 'name').toQueryString()).get('select')).toBe(
      'id,name',
    );
  });

  it('builds search, sort, and pagination params', () => {
    const qs = query()
      .search('acme corp')
      .sort('created_at', 'desc')
      .sort('name', 'asc')
      .page(2)
      .pageSize(50)
      .toQueryString();
    const params = new URLSearchParams(qs);
    expect(params.get('search')).toBe('acme corp');
    expect(params.get('sort')).toBe('-created_at,name');
    expect(params.get('page')).toBe('2');
    expect(params.get('pageSize')).toBe('50');
  });

  it('builds expand and select lists', () => {
    const qs = query().expand('company', 'owner').select('id', 'name').toQueryString();
    const params = new URLSearchParams(qs);
    expect(params.get('expand')).toBe('company,owner');
    expect(params.get('select')).toBe('id,name');
  });

  it('throws on an unknown operator', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => query().where('a', 'bogus', 1)).toThrow(/Unknown operator/);
  });

  it('is reusable via the class constructor', () => {
    const b = new QueryBuilder().eq('a', 1);
    expect(b.toString()).toBe('a=1');
  });
});
