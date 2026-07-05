import { describe, expect, it } from 'vitest';
import { computeDiff } from './diff.js';

describe('computeDiff', () => {
  it('captures changed, added, and removed fields', () => {
    const diff = computeDiff(
      { name: 'Ann', age: 30, nickname: 'A' },
      { name: 'Anne', age: 30, title: 'Dr' },
    );
    expect(diff).toEqual({
      name: { before: 'Ann', after: 'Anne' },
      nickname: { before: 'A', after: undefined },
      title: { before: undefined, after: 'Dr' },
    });
  });

  it('returns null when only system-managed columns differ', () => {
    const before = {
      name: 'Ann',
      created_at: new Date('2020-01-01'),
      updated_at: new Date('2020-01-01'),
    };
    const after = {
      name: 'Ann',
      created_at: new Date('2020-01-01'),
      updated_at: new Date('2026-07-05'),
    };
    expect(computeDiff(before, after)).toBeNull();
  });

  it('never includes created_at / updated_at / *_by in the diff', () => {
    const diff = computeDiff(
      { name: 'Ann', updated_at: new Date('2020-01-01'), updated_by: 'u1' },
      { name: 'Anne', updated_at: new Date('2026-07-05'), updated_by: 'u2' },
    );
    expect(diff).toEqual({ name: { before: 'Ann', after: 'Anne' } });
    expect(diff).not.toHaveProperty('updated_at');
    expect(diff).not.toHaveProperty('updated_by');
  });

  it('diffs nested object/array values structurally', () => {
    expect(computeDiff({ tags: ['a'] }, { tags: ['a'] })).toBeNull();
    expect(computeDiff({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual({
      tags: { before: ['a'], after: ['a', 'b'] },
    });
  });

  it('returns null when nothing changed', () => {
    expect(computeDiff({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBeNull();
  });
});
