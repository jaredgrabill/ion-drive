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
 * Relationships traverse as nested fields (Phase 13): each relation key from
 * `data/relation-keys.ts` becomes a field on the object type (single for the
 * FK side, list for many_to_many and reverse `<obj>_by_<rel>` keys), resolved
 * through the per-request RelationLoader so sibling rows batch into one
 * `DataService.hydrateRelation` fetch. many_to_many keys also get
 * `link_<obj>_<rel>` / `unlink_<obj>_<rel>` mutations. The resulting type
 * graph is cyclic, so the plugin enforces a query depth cap (depth-limit.ts).
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
import type { PermissionEngine } from '../../auth/rbac/permission-engine.js';
import type { ActionExecutor, DeclaredAction } from '../../blocks/action-executor.js';
import type { DataService } from '../../data/data-service.js';
import { type RelationKey, listRelationKeys } from '../../data/relation-keys.js';
import type { RealtimeBridge } from '../../messaging/realtime.js';
import type { SchemaRegistry } from '../../schema/schema-registry.js';
import type { DataObjectDefinition, FieldDefinition } from '../../schema/types.js';
import type { RelationLoaderContext } from './relation-loader.js';
import {
  makeActionResolver,
  makeCreateResolver,
  makeDeleteResolver,
  makeGetResolver,
  makeLinkResolver,
  makeListResolver,
  makeUpdateResolver,
} from './resolver-factory.js';
import { DateTimeScalar, JSONScalar } from './scalars.js';
import { makeEventsSubscribe } from './subscriptions.js';

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

/** A GraphQL type usable in both input and output positions. */
type DualPositionType = GraphQLOutputType & GraphQLInputType;

/** GraphQL enum value name rules (also excludes the reserved literals). */
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const GRAPHQL_RESERVED = new Set(['true', 'false', 'null']);

/**
 * Builds a real GraphQL enum type for a select field whose values are all
 * identifier-safe, or returns null to fall back to String. The instance is
 * built once per object (see {@link buildFieldTypeMap}) so the output type
 * and the create/update inputs share it — GraphQL requires unique type names.
 */
function buildEnumType(objName: string, field: FieldDefinition): GraphQLEnumType | null {
  const values = field.constraints?.enumValues;
  if (!values?.length) return null;
  const safe = values.every((v) => GRAPHQL_NAME.test(v) && !GRAPHQL_RESERVED.has(v));
  if (!safe || new Set(values).size !== values.length) return null;

  return new GraphQLEnumType({
    name: `${pascalCase(objName)}${pascalCase(field.name)}Enum`,
    description: field.description ?? `Allowed values for ${field.displayName}.`,
    values: Object.fromEntries(values.map((v) => [v, { value: v }])),
  });
}

/**
 * Resolves each field of an object to its GraphQL type once, so enum types
 * are shared across the output type and both input types.
 */
function buildFieldTypeMap(obj: DataObjectDefinition): Map<string, DualPositionType> {
  const map = new Map<string, DualPositionType>();
  for (const field of obj.fields) {
    if (field.columnType === 'enum' || field.columnType === 'multi_enum') {
      const enumType = buildEnumType(obj.name, field);
      if (enumType) {
        map.set(
          field.name,
          field.columnType === 'multi_enum' ? new GraphQLList(enumType) : enumType,
        );
        continue;
      }
    }
    map.set(field.name, columnToGraphQLType(field));
  }
  return map;
}

/**
 * Maps an Ion Drive column type to a GraphQL type (used for both input and
 * output positions — the mappable scalar/list types are identical).
 */
function columnToGraphQLType(field: FieldDefinition): DualPositionType {
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
 *
 * Relation keys become nested fields resolved through the per-request
 * RelationLoader (batched); the `fields` thunk runs after every object type
 * is registered in `typeByObject`, so cyclic references are fine. Column
 * fields win any name collision (relation-keys already drops those keys).
 */
function buildObjectType(
  obj: DataObjectDefinition,
  fieldTypes: Map<string, DualPositionType>,
  typeByObject: Map<string, GraphQLObjectType>,
  dataService: DataService,
): GraphQLObjectType {
  return new GraphQLObjectType({
    name: pascalCase(obj.name),
    description: obj.description ?? undefined,
    fields: () => {
      const fields: GraphQLFieldConfigMap<Record<string, unknown>, unknown> = {};
      for (const field of obj.fields) {
        const base = fieldTypes.get(field.name) ?? columnToGraphQLType(field);
        fields[field.name] = {
          type: field.isPrimary ? new GraphQLNonNull(base) : base,
          description: field.description ?? field.displayName,
          resolve: (source) => source[field.columnName],
        };
      }
      addRelationFields(fields, obj, typeByObject, dataService);
      return fields;
    },
  });
}

/** Appends the object's relation keys as nested (loader-resolved) fields. */
function addRelationFields(
  fields: GraphQLFieldConfigMap<Record<string, unknown>, unknown>,
  obj: DataObjectDefinition,
  typeByObject: Map<string, GraphQLObjectType>,
  dataService: DataService,
): void {
  for (const relationKey of listRelationKeys(obj)) {
    const otherType = typeByObject.get(relationKey.otherObject);
    if (!otherType || fields[relationKey.key]) continue;
    fields[relationKey.key] = {
      type:
        relationKey.kind === 'list'
          ? new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(otherType)))
          : otherType,
      description: relationDescription(relationKey),
      resolve: (source, _args, context) =>
        resolveRelation(dataService, obj.name, relationKey.key, source, context),
    };
  }
}

/** Human description of a relation field for the SDL. */
function relationDescription(key: RelationKey): string {
  const shape = key.kind === 'single' ? 'The related' : 'Related';
  const suffix = key.kind === 'single' ? 'record' : 'records';
  return `${shape} ${key.otherObject} ${suffix} (${key.rel.type} "${key.rel.name}").`;
}

/**
 * Resolves a relation field: batched through the request's RelationLoader
 * when present, else a direct single-row hydration (programmatic execution
 * without the plugin's context, e.g. tests).
 */
function resolveRelation(
  dataService: DataService,
  objectName: string,
  relKey: string,
  source: Record<string, unknown>,
  context: unknown,
): Promise<unknown> {
  const loader = (context as RelationLoaderContext | null)?.relationLoader;
  if (loader) return loader.load(objectName, relKey, source);
  return dataService.hydrateRelation(objectName, [source], relKey).then(() => source[relKey]);
}

/** Fields eligible for user input (excludes system + primary-key fields). */
function writableFields(obj: DataObjectDefinition): FieldDefinition[] {
  return obj.fields.filter((f) => !f.isSystem && !f.isPrimary);
}

/**
 * Builds create/update input types. Returns `undefined` for each when the
 * object has no writable fields (an empty input type is invalid in GraphQL).
 */
function buildInputTypes(
  obj: DataObjectDefinition,
  fieldTypes: Map<string, DualPositionType>,
): {
  create?: GraphQLInputObjectType;
  update?: GraphQLInputObjectType;
} {
  const writable = writableFields(obj);
  if (writable.length === 0) return {};

  const createFields: GraphQLInputFieldConfigMap = {};
  const updateFields: GraphQLInputFieldConfigMap = {};
  for (const field of writable) {
    const base = fieldTypes.get(field.name) ?? columnToGraphQLType(field);
    createFields[field.name] = {
      type: field.isRequired ? new GraphQLNonNull(base) : base,
      description: field.description ?? undefined,
    };
    updateFields[field.name] = { type: base, description: field.description ?? undefined };
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
 * Optional Phase 13 surface extensions. All absent in minimal builds (tests,
 * headless embedders): the schema then contains only the CRUD reflection.
 */
export interface GraphQLSchemaExtras {
  /**
   * Installed blocks' declared actions — each becomes
   * `Mutation.<block>_<action>(input: JSON): JSON` running through the shared
   * ActionExecutor (requires `actionExecutor` + `permissionEngine`).
   */
  declaredActions?: DeclaredAction[];
  actionExecutor?: ActionExecutor;
  permissionEngine?: PermissionEngine;
  /** Whether RBAC is enforced (action mutations + subscription auth). */
  enforce?: boolean;
  /** Present when the outbox bus is live — enables `Subscription.events`. */
  realtime?: RealtimeBridge;
}

/**
 * Builds the full GraphQL schema from the current registry state.
 */
export function buildGraphQLSchema(
  registry: SchemaRegistry,
  dataService: DataService,
  extras: GraphQLSchemaExtras = {},
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

  // First pass: register every object type so relation fields (resolved in
  // the lazy `fields` thunks) can reference each other, cycles included.
  const typeByObject = new Map<string, GraphQLObjectType>();
  const fieldTypesByObject = new Map<string, Map<string, DualPositionType>>();
  for (const obj of objects) {
    const fieldTypes = buildFieldTypeMap(obj);
    fieldTypesByObject.set(obj.name, fieldTypes);
    typeByObject.set(obj.name, buildObjectType(obj, fieldTypes, typeByObject, dataService));
  }

  for (const obj of objects) {
    const fieldTypes = fieldTypesByObject.get(obj.name) ?? buildFieldTypeMap(obj);
    const objectType = typeByObject.get(obj.name);
    if (!objectType) continue; // unreachable — the first pass covers every object
    const { create: createInput, update: updateInput } = buildInputTypes(obj, fieldTypes);

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

    // Link writes — one mutation pair per many_to_many relation key (Phase 13).
    for (const relationKey of listRelationKeys(obj).filter((k) => k.via === 'junction')) {
      const linkArgs = {
        id: { type: new GraphQLNonNull(GraphQLID) },
        ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) },
      };
      mutationFields[`link_${obj.name}_${relationKey.key}`] = {
        type: new GraphQLNonNull(GraphQLInt),
        description: `Link ${relationKey.otherObject} records to a ${obj.displayName} record via "${relationKey.key}". Idempotent; returns the number of links added.`,
        args: linkArgs,
        resolve: makeLinkResolver(dataService, obj.name, relationKey.key, 'link'),
      };
      mutationFields[`unlink_${obj.name}_${relationKey.key}`] = {
        type: new GraphQLNonNull(GraphQLInt),
        description: `Unlink ${relationKey.otherObject} records from a ${obj.displayName} record via "${relationKey.key}". Returns the number of links removed.`,
        args: linkArgs,
        resolve: makeLinkResolver(dataService, obj.name, relationKey.key, 'unlink'),
      };
    }
  }

  addActionMutations(mutationFields, extras);

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    mutation:
      Object.keys(mutationFields).length > 0
        ? new GraphQLObjectType({ name: 'Mutation', fields: mutationFields })
        : undefined,
    subscription: buildSubscriptionType(extras),
  });
}

/**
 * Reflects installed blocks' declared actions as mutations (Phase 13 — the
 * GraphQL face of the Phase 14 action seam). Input stays a JSON scalar: the
 * handler's Zod schema is the validator, and deriving typed GraphQL inputs
 * from Zod would be a fidelity trap (unions, refinements) for no real gain.
 */
function addActionMutations(
  mutationFields: GraphQLFieldConfigMap<unknown, unknown>,
  extras: GraphQLSchemaExtras,
): void {
  const { declaredActions, actionExecutor, permissionEngine } = extras;
  if (!declaredActions?.length || !actionExecutor || !permissionEngine) return;

  const deps = { actionExecutor, permissionEngine, enforce: extras.enforce ?? false };
  for (const action of declaredActions) {
    // Block names may contain hyphens; GraphQL names may not.
    const fieldName = `${action.block}_${action.name}`.replace(/[^_0-9A-Za-z]/g, '_');
    if (mutationFields[fieldName]) continue;
    mutationFields[fieldName] = {
      type: JSONScalar,
      description:
        action.description ?? `Invoke the "${action.block}" block's "${action.name}" action.`,
      args: {
        input: {
          type: JSONScalar,
          description: "Action input object (validated by the handler's registered schema).",
        },
      },
      resolve: makeActionResolver(deps, action.block, action.name),
    };
  }
}

/**
 * `Subscription.events(topics)` — the realtime feed over the Phase 12 bridge
 * (yoga serves it over GraphQL-SSE). Only present when the outbox bus is
 * live, mirroring `GET /api/v1/events/stream`.
 */
function buildSubscriptionType(extras: GraphQLSchemaExtras): GraphQLObjectType | undefined {
  const { realtime, permissionEngine } = extras;
  if (!realtime || !permissionEngine) return undefined;

  const eventType = new GraphQLObjectType({
    name: 'IonEvent',
    description: 'An event from the platform outbox (see docs/concepts/events.md).',
    fields: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      topic: { type: new GraphQLNonNull(GraphQLString) },
      occurredAt: { type: new GraphQLNonNull(DateTimeScalar) },
      payload: { type: JSONScalar },
    },
  });

  return new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      events: {
        type: new GraphQLNonNull(eventType),
        description:
          'Realtime change feed. Best-effort from subscribe time (a feed, not a queue); each event is RBAC-filtered for the connected principal. Same semantics as GET /api/v1/events/stream.',
        args: {
          topics: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
            description:
              'Topic patterns (`data.contacts.*`, `data.#`, …). Default: `data.#` (all data changes).',
          },
        },
        subscribe: makeEventsSubscribe({
          realtime,
          permissionEngine,
          enforce: extras.enforce ?? false,
        }),
        resolve: (event: unknown) => event,
      },
    },
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
