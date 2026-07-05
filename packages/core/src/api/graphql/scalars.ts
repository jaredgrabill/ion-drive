/**
 * Custom GraphQL scalars for Ion Drive's dynamic schema.
 *
 * Ion Drive maps runtime column types to GraphQL types. Two of those mappings
 * need scalars that graphql-js doesn't provide out of the box:
 *
 *   - `DateTime` — serializes JS `Date` values (returned by the pg driver) to
 *     ISO 8601 strings, and accepts ISO strings as input.
 *   - `JSON` — an opaque passthrough for JSONB columns and arrays, where the
 *     shape is defined by the tenant's data rather than the GraphQL schema.
 */

import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';

/**
 * Recursively converts a GraphQL AST literal node into a plain JS value.
 * Used by the JSON scalar to accept inline object/array literals.
 */
function parseLiteralValue(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return ast.value;
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
      return Number.parseInt(ast.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(parseLiteralValue);
    case Kind.OBJECT:
      return Object.fromEntries(
        ast.fields.map((field) => [field.name.value, parseLiteralValue(field.value)]),
      );
    default:
      return null;
  }
}

export const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description: 'An ISO 8601 date-time string (RFC 3339).',
  serialize(value) {
    if (value instanceof Date) return value.toISOString();
    // pg may already return a string for DATE/TIME columns.
    return value == null ? null : String(value);
  },
  parseValue(value) {
    return value == null ? null : String(value);
  },
  parseLiteral(ast) {
    return ast.kind === Kind.STRING ? ast.value : null;
  },
});

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value (objects, arrays, or scalars).',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: parseLiteralValue,
});
