import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { createDepthLimitRule } from './depth-limit.js';

// A deliberately cyclic schema — the shape traversal creates.
const schema = buildSchema(`
  type Query { me: Person }
  type Person { name: String, friend: Person }
`);

function errorsFor(source: string, maxDepth: number) {
  return validate(schema, parse(source), [createDepthLimitRule(maxDepth)]);
}

describe('createDepthLimitRule', () => {
  it('passes queries at or under the limit', () => {
    expect(errorsFor('{ me { friend { name } } }', 3)).toEqual([]);
  });

  it('rejects queries past the limit with the measured depth', () => {
    const errors = errorsFor('{ me { friend { friend { friend { name } } } } }', 3);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('depth 5 exceeds the maximum allowed depth of 3');
  });

  it('counts fragment spreads at their spread depth (cycles guarded)', () => {
    const source = `
      query { me { ...deep } }
      fragment deep on Person { friend { friend { name } } }
    `;
    expect(errorsFor(source, 4)).toEqual([]);
    expect(errorsFor(source, 3)).toHaveLength(1);
  });

  it('exempts introspection fields so GraphiQL keeps working', () => {
    const introspection = `
      { __schema { types { fields { type { ofType { ofType { ofType { name } } } } } } } }
    `;
    expect(errorsFor(introspection, 3)).toEqual([]);
  });
});
