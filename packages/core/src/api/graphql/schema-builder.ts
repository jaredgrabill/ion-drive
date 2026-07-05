/**
 * GraphQL Schema Builder — constructs a GraphQLSchema from the runtime registry.
 *
 * Ion Drive's objects are defined at runtime, so the GraphQL schema is *reflected*
 * from the Schema Registry rather than written by hand. For each non-system
 * object `foo` we generate:
 *
 *   type Foo { <fields> }            — output type (resolves by column name)
 *   input FooCreateInput { ... }     — required fields are non-null
 *   input FooUpdateInput { ... }     — all fields optional (partial update)
 *   type FooListResult { data, pagination }
 *
 *   Query.foo(filter, sort, page, pageSize): FooListResult!
 *   Query.foo_by_id(id): Foo
 *   Mutation.create_foo(input): Foo
 *   Mutation.update_foo(id, input): Foo
 *   Mutation.delete_foo(id): Boolean!
 *
 * This is the code-first counterpart to the runtime REST routes (ADR-009). We
 * use graphql-js type constructors directly — for a schema whose shape is only
 * known at runtime, they are cleaner than a compile-time builder like Pothos.
 *
 * Schemas are cheap to rebuild; the plugin caches by registry version.
 */

import {
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLID,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';
import type { DataService } from '../../data/data-service.js';
import type { SchemaRegistry } from '../../schema/schema-registry.js';
import type { DataObjectDefinition, FieldDefinition } from '../../schema/types.js';
import {
  makeCreateResolver,
  makeDeleteResolver,
  makeGetResolver,
  makeListResolver,
  makeUpdateResolver,
} from './resolver-factory.js';
import { DateTimeScalar, JSONScalar } from './scalars.js';

// ---------------------------------------------------------------------------
// Shared types (built once, reused across all objects)
// ---------------------------------------------------------------------------

const FilterOperatorEnum = new GraphQLEnumType({
  name: 'FilterOperator',
  values: {
    eq: {},
    neq: {},
    gt: {},
    gte: {},
    lt: {},
    lte: {},
    like: {},
    ilike: {},
    in: {},
    nin: {},
    is_null: {},
    is_not_null: {},
  },
});

const SortDirectionEnum = new GraphQLEnumType({
  name: 'SortDirection',
  values: { asc: {}, desc: {} },
});

const FilterInput = new GraphQLInputObjectType({
  name: 'FilterInput',
  fields: {
    field: { type: new GraphQLNonNull(GraphQLString) },
    operator: { type: new GraphQLNonNull(FilterOperatorEnum) },
    value: { type: JSONScalar },
  },
});

const SortInput = new GraphQLInputObjectType({
  name: 'SortInput',
  fields: {
    field: { type: new GraphQLNonNull(GraphQLString) },
    direction: { type: new GraphQLNonNull(SortDirectionEnum) },
  },
});

const PaginationMeta = new GraphQLObjectType({
  name: 'PaginationMeta',
  fields: {
    page: { type: new GraphQLNonNull(GraphQLInt) },
    pageSize: { type: new GraphQLNonNull(GraphQLInt) },
    totalCount: { type: new GraphQLNonNull(GraphQLInt) },
    totalPages: { type: new GraphQLNonNull(GraphQLInt) },
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

/**
 * Maps an Ion Drive column type to a GraphQL type (used for both input and
 * output positions — the mappable scalar/list types are identical).
 */
function columnToGraphQLType(field: FieldDefinition): GraphQLOutputType & GraphQLInputType {
  switch (field.columnType) {
    case 'integer':
    case 'auto_increment':
    case 'rating':
      return GraphQLInt;
    case 'big_integer':
    case 'decimal':
    case 'float':
    case 'percentage':
    case 'currency':
      return GraphQLFloat;
    case 'boolean':
      return GraphQLBoolean;
    case 'date':
    case 'datetime':
    case 'time':
      return DateTimeScalar;
    case 'uuid':
      return GraphQLID;
    case 'json':
      return JSONScalar;
    case 'array_integer':
      return new GraphQLList(GraphQLInt);
    case 'array_text':
    case 'multi_enum':
      return new GraphQLList(GraphQLString);
    default:
      // text, email, url, slug, enum, color, ip_address, etc.
      return GraphQLString;
  }
}

/**
 * Builds the output object type for a data object. Field resolvers read the
 * physical column name, since DataService returns column-keyed rows.
 */
function buildObjectType(obj: DataObjectDefinition): GraphQLObjectType {
  return new GraphQLObjectType({
    name: pascalCase(obj.name),
    description: obj.description ?? undefined,
    fields: () => {
      const fields: GraphQLFieldConfigMap<Record<string, unknown>, unknown> = {};
      for (const field of obj.fields) {
        const base = columnToGraphQLType(field);
        fields[field.name] = {
          type: field.isPrimary ? new GraphQLNonNull(base) : base,
          description: field.displayName,
          resolve: (source) => source[field.columnName],
        };
      }
      return fields;
    },
  });
}

/** Fields eligible for user input (excludes system + primary-key fields). */
function writableFields(obj: DataObjectDefinition): FieldDefinition[] {
  return obj.fields.filter((f) => !f.isSystem && !f.isPrimary);
}

/**
 * Builds create/update input types. Returns `undefined` for each when the
 * object has no writable fields (an empty input type is invalid in GraphQL).
 */
function buildInputTypes(obj: DataObjectDefinition): {
  create?: GraphQLInputObjectType;
  update?: GraphQLInputObjectType;
} {
  const writable = writableFields(obj);
  if (writable.length === 0) return {};

  const createFields: GraphQLInputFieldConfigMap = {};
  const updateFields: GraphQLInputFieldConfigMap = {};
  for (const field of writable) {
    const base = columnToGraphQLType(field);
    createFields[field.name] = {
      type: field.isRequired ? new GraphQLNonNull(base) : base,
    };
    updateFields[field.name] = { type: base };
  }

  const pascal = pascalCase(obj.name);
  return {
    create: new GraphQLInputObjectType({ name: `${pascal}CreateInput`, fields: createFields }),
    update: new GraphQLInputObjectType({ name: `${pascal}UpdateInput`, fields: updateFields }),
  };
}

// ---------------------------------------------------------------------------
// Schema assembly
// ---------------------------------------------------------------------------

/**
 * Builds the full GraphQL schema from the current registry state.
 */
export function buildGraphQLSchema(
  registry: SchemaRegistry,
  dataService: DataService,
): GraphQLSchema {
  const objects = registry.listObjects().filter((o) => !o.isSystem);

  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {
    // Always-present introspection fields guarantee a non-empty Query type
    // even before any objects exist.
    ion_schema_version: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Current schema registry version.',
      resolve: () => registry.getVersion(),
    },
    ion_objects: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      description: 'Names of all queryable data objects.',
      resolve: () => objects.map((o) => o.name),
    },
  };

  const mutationFields: GraphQLFieldConfigMap<unknown, unknown> = {};

  for (const obj of objects) {
    const objectType = buildObjectType(obj);
    const { create: createInput, update: updateInput } = buildInputTypes(obj);

    const listResult = new GraphQLObjectType({
      name: `${pascalCase(obj.name)}ListResult`,
      fields: {
        data: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
        },
        pagination: { type: new GraphQLNonNull(PaginationMeta) },
      },
    });

    // --- Queries ---
    queryFields[obj.name] = {
      type: new GraphQLNonNull(listResult),
      description: `List ${obj.displayName} records.`,
      args: {
        filter: { type: new GraphQLList(new GraphQLNonNull(FilterInput)) },
        search: {
          type: GraphQLString,
          description: 'Free-text search across text-like columns.',
        },
        sort: { type: new GraphQLList(new GraphQLNonNull(SortInput)) },
        page: { type: GraphQLInt },
        pageSize: { type: GraphQLInt },
        limit: { type: GraphQLInt, description: 'Offset-based: max rows to return.' },
        offset: { type: GraphQLInt, description: 'Offset-based: rows to skip.' },
      },
      resolve: makeListResolver(dataService, obj.name),
    } as GraphQLFieldConfig<unknown, unknown>;

    queryFields[`${obj.name}_by_id`] = {
      type: objectType,
      description: `Get a single ${obj.displayName} record by ID.`,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: makeGetResolver(dataService, obj.name),
    };

    // --- Mutations ---
    mutationFields[`create_${obj.name}`] = {
      type: objectType,
      description: `Create a ${obj.displayName} record.`,
      args: createInput ? { input: { type: new GraphQLNonNull(createInput) } } : {},
      resolve: makeCreateResolver(dataService, obj.name),
    };

    if (updateInput) {
      mutationFields[`update_${obj.name}`] = {
        type: objectType,
        description: `Update a ${obj.displayName} record.`,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          input: { type: new GraphQLNonNull(updateInput) },
        },
        resolve: makeUpdateResolver(dataService, obj.name),
      };
    }

    mutationFields[`delete_${obj.name}`] = {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: `Delete a ${obj.displayName} record by ID.`,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: makeDeleteResolver(dataService, obj.name),
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    mutation:
      Object.keys(mutationFields).length > 0
        ? new GraphQLObjectType({ name: 'Mutation', fields: mutationFields })
        : undefined,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pascalCase(str: string): string {
  return str
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}
