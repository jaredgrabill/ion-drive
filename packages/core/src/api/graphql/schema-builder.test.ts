import { GraphQLError, graphql, printSchema } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { type DataService, DataServiceError } from '../../data/data-service.js';
import { SchemaRegistry } from '../../schema/schema-registry.js';
import type { DataObjectDefinition, RelationshipDefinition } from '../../schema/types.js';
import { RelationLoader } from './relation-loader.js';
import { buildGraphQLSchema } from './schema-builder.js';

const CONTACTS: DataObjectDefinition = {
  name: 'contacts',
  displayName: 'Contacts',
  tableName: 'contacts',
  fields: [
    {
      name: 'id',
      displayName: 'ID',
      columnName: 'id',
      columnType: 'uuid',
      isPrimary: true,
      isSystem: true,
    },
    {
      name: 'full_name',
      displayName: 'Full Name',
      columnName: 'full_name',
      columnType: 'text',
      isRequired: true,
    },
    { name: 'age', displayName: 'Age', columnName: 'age', columnType: 'integer' },
    // Field whose GraphQL name differs from its physical column name.
    { name: 'email', displayName: 'Email', columnName: 'email_address', columnType: 'email' },
  ],
};

function registryWithContacts(): SchemaRegistry {
  const registry = new SchemaRegistry();
  registry.registerObject(CONTACTS);
  return registry;
}

describe('buildGraphQLSchema', () => {
  it('reflects queries, mutations, and input types for each object', () => {
    const sdl = printSchema(buildGraphQLSchema(registryWithContacts(), {} as DataService));

    expect(sdl).toContain('type Contacts');
    expect(sdl).toContain('type ContactsListResult');
    expect(sdl).toContain('input ContactsCreateInput');
    expect(sdl).toContain('input ContactsUpdateInput');
    // Query + mutation fields
    expect(sdl).toMatch(/contacts\(/);
    expect(sdl).toContain('contacts_by_id(');
    expect(sdl).toContain('create_contacts(');
    expect(sdl).toContain('update_contacts(');
    expect(sdl).toContain('delete_contacts(');
    // Required field is non-null in create input, optional in update input
    expect(sdl).toMatch(/input ContactsCreateInput \{[^}]*full_name: String!/s);
    expect(sdl).toMatch(/input ContactsUpdateInput \{[^}]*full_name: String\b(?!!)/s);
  });

  it('always exposes introspection fields even with no objects', () => {
    const sdl = printSchema(buildGraphQLSchema(new SchemaRegistry(), {} as DataService));
    expect(sdl).toContain('ion_schema_version');
    expect(sdl).toContain('ion_objects');
    // No objects → no Mutation type
    expect(sdl).not.toContain('type Mutation');
  });

  it('resolves list queries through the DataService and maps column names', async () => {
    const dataService = {
      list: async () => ({
        data: [{ id: '1', full_name: 'Ada', age: 30, email_address: 'ada@example.com' }],
        pagination: {
          page: 1,
          pageSize: 25,
          totalCount: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      }),
    } as unknown as DataService;

    const schema = buildGraphQLSchema(registryWithContacts(), dataService);
    const result = await graphql({
      schema,
      source: '{ contacts { data { id full_name age email } pagination { totalCount } } }',
    });

    expect(result.errors).toBeUndefined();
    const contacts = (result.data as Record<string, { data: Record<string, unknown>[] }>).contacts;
    expect(contacts.data[0]).toMatchObject({
      full_name: 'Ada',
      age: 30,
      // `email` resolves from the `email_address` column
      email: 'ada@example.com',
    });
  });

  it('reflects an aggregate query field per object', () => {
    const sdl = printSchema(buildGraphQLSchema(registryWithContacts(), {} as DataService));
    expect(sdl).toContain('contacts_aggregate(');
    expect(sdl).toContain('enum AggregateFunction');
    expect(sdl).toMatch(/type AggregateResult \{[^}]*filteredCount: Int!/s);
  });

  it('resolves aggregate queries through DataService.aggregate', async () => {
    const aggregate = vi
      .fn()
      .mockResolvedValue({ fn: 'avg', field: 'age', value: 33.5, filteredCount: 2 });
    const dataService = { aggregate } as unknown as DataService;

    const schema = buildGraphQLSchema(registryWithContacts(), dataService);
    const result = await graphql({
      schema,
      source:
        '{ contacts_aggregate(fn: avg, field: "age", filter: [{ field: "age", operator: gte, value: 18 }], search: "acme") { fn field value filteredCount } }',
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as Record<string, unknown>).contacts_aggregate).toEqual({
      fn: 'avg',
      field: 'age',
      value: 33.5,
      filteredCount: 2,
    });
    expect(aggregate).toHaveBeenCalledWith('contacts', 'avg', 'age', {
      filters: [{ field: 'age', operator: 'gte', value: 18 }],
      search: 'acme',
    });
  });

  it('returns a boolean from delete mutations', async () => {
    const dataService = { delete: async () => true } as unknown as DataService;
    const schema = buildGraphQLSchema(registryWithContacts(), dataService);
    const result = await graphql({
      schema,
      source: 'mutation { delete_contacts(id: "1") }',
    });
    expect(result.errors).toBeUndefined();
    expect((result.data as Record<string, unknown>).delete_contacts).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Relationship traversal (Phase 13)
// ---------------------------------------------------------------------------

const COMPANY_REL: RelationshipDefinition = {
  name: 'company',
  displayName: 'Company',
  type: 'many_to_one',
  sourceObjectName: 'contacts',
  targetObjectName: 'companies',
};

const TAGS_REL: RelationshipDefinition = {
  name: 'tags',
  displayName: 'Tags',
  type: 'many_to_many',
  sourceObjectName: 'contacts',
  targetObjectName: 'tags',
  junctionTable: 'contacts_tags',
  junctionSourceColumn: 'contacts_id',
  junctionTargetColumn: 'tags_id',
};

function relationalRegistry(): SchemaRegistry {
  const registry = new SchemaRegistry();
  registry.registerObject({
    ...CONTACTS,
    fields: [
      ...CONTACTS.fields,
      {
        name: 'company_id',
        displayName: 'Company ID',
        columnName: 'company_id',
        columnType: 'uuid',
      },
    ],
    relationships: [COMPANY_REL, TAGS_REL],
  });
  registry.registerObject({
    name: 'companies',
    displayName: 'Companies',
    tableName: 'companies',
    fields: [
      {
        name: 'id',
        displayName: 'ID',
        columnName: 'id',
        columnType: 'uuid',
        isPrimary: true,
        isSystem: true,
      },
      { name: 'name', displayName: 'Name', columnName: 'name', columnType: 'text' },
    ],
    relationships: [COMPANY_REL],
  });
  registry.registerObject({
    name: 'tags',
    displayName: 'Tags',
    tableName: 'tags',
    fields: [
      {
        name: 'id',
        displayName: 'ID',
        columnName: 'id',
        columnType: 'uuid',
        isPrimary: true,
        isSystem: true,
      },
      { name: 'label', displayName: 'Label', columnName: 'label', columnType: 'text' },
    ],
    relationships: [TAGS_REL],
  });
  return registry;
}

describe('relationship traversal', () => {
  it('reflects relation fields on both sides plus link mutations in the SDL', () => {
    const sdl = printSchema(buildGraphQLSchema(relationalRegistry(), {} as DataService));

    // FK side: single nullable; m2m: non-null list; reverse: list.
    expect(sdl).toMatch(/type Contacts \{[^}]*company: Companies\b/s);
    expect(sdl).toMatch(/type Contacts \{[^}]*tags: \[Tags!\]!/s);
    expect(sdl).toMatch(/type Companies \{[^}]*contacts_by_company: \[Contacts!\]!/s);
    expect(sdl).toMatch(/type Tags \{[^}]*tags: \[Contacts!\]!/s);
    expect(sdl).toContain('link_contacts_tags(');
    expect(sdl).toContain('unlink_contacts_tags(');
    // FK-only relationships get no link mutations.
    expect(sdl).not.toContain('link_contacts_company');
  });

  it('batches sibling rows into one hydrateRelation call via the loader', async () => {
    const hydrateRelation = vi.fn(
      async (_obj: string, rows: Record<string, unknown>[], key: string) => {
        for (const row of rows) row[key] = { id: 'co1', name: 'Acme' };
      },
    );
    const dataService = {
      list: async () => ({
        data: [
          { id: 'c1', full_name: 'Ada', company_id: 'co1' },
          { id: 'c2', full_name: 'Grace', company_id: 'co1' },
        ],
        pagination: {
          page: 1,
          pageSize: 25,
          totalCount: 2,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      }),
      hydrateRelation,
    } as unknown as DataService;

    const schema = buildGraphQLSchema(relationalRegistry(), dataService);
    const result = await graphql({
      schema,
      source: '{ contacts { data { full_name company { name } } } }',
      contextValue: { relationLoader: new RelationLoader(dataService) },
    });

    expect(result.errors).toBeUndefined();
    const rows = (result.data as { contacts: { data: Record<string, unknown>[] } }).contacts.data;
    expect(rows[0]?.company).toMatchObject({ name: 'Acme' });
    expect(rows[1]?.company).toMatchObject({ name: 'Acme' });
    // Both rows hydrated in ONE batched call.
    expect(hydrateRelation).toHaveBeenCalledTimes(1);
    expect(hydrateRelation.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it('falls back to direct hydration without a loader in context', async () => {
    const dataService = {
      getById: async () => ({ data: { id: 'c1', company_id: 'co1' } }),
      hydrateRelation: vi.fn(async (_obj: string, rows: Record<string, unknown>[], key: string) => {
        for (const row of rows) row[key] = { id: 'co1', name: 'Acme' };
      }),
    } as unknown as DataService;

    const schema = buildGraphQLSchema(relationalRegistry(), dataService);
    const result = await graphql({
      schema,
      source: '{ contacts_by_id(id: "c1") { company { name } } }',
    });

    expect(result.errors).toBeUndefined();
    expect(
      (result.data as { contacts_by_id: { company: { name: string } } }).contacts_by_id.company,
    ).toMatchObject({ name: 'Acme' });
  });

  it('reflects Subscription.events when a realtime bridge is supplied', () => {
    const sdl = printSchema(
      buildGraphQLSchema(registryWithContacts(), {} as DataService, {
        realtime: {} as never,
        permissionEngine: {} as never,
      }),
    );
    expect(sdl).toContain('type Subscription');
    // The topics arg carries a description, so printSchema renders it multi-line.
    expect(sdl).toMatch(/events\([\s\S]*?topics: \[String!\]\s*\): IonEvent!/);
    expect(sdl).toContain('type IonEvent');
  });

  it('reflects and executes block-action mutations through the ActionExecutor', async () => {
    const executeAction = vi.fn(async () => ({ url: 'https://pay.example' }));
    const actionExecutor = {
      resolveAction: async () => ({
        definition: { block: 'invoicing', name: 'create_payment_link' },
        rbac: { resource: 'blocks', action: 'update' },
      }),
      executeAction,
    } as never;

    const schema = buildGraphQLSchema(registryWithContacts(), {} as DataService, {
      declaredActions: [
        { block: 'invoicing', name: 'create_payment_link', description: 'Create a payment link' },
      ],
      actionExecutor,
      permissionEngine: { can: async () => true } as never,
      enforce: false,
    });

    expect(printSchema(schema)).toMatch(
      /invoicing_create_payment_link\([\s\S]*?input: JSON\s*\): JSON/,
    );

    const result = await graphql({
      schema,
      source: 'mutation { invoicing_create_payment_link(input: { invoice_id: "i1" }) }',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      invoicing_create_payment_link: { url: 'https://pay.example' },
    });
    expect(executeAction).toHaveBeenCalledWith(
      { block: 'invoicing', name: 'create_payment_link' },
      { invoice_id: 'i1' },
      null,
    );
  });

  it('surfaces ActionErrors as GraphQL errors instead of masked internals', async () => {
    const { ActionError } = await import('../../blocks/action-executor.js');
    const actionExecutor = {
      resolveAction: async () => {
        throw new ActionError('not_found', 'Block "invoicing" is not installed');
      },
    } as never;

    const schema = buildGraphQLSchema(registryWithContacts(), {} as DataService, {
      declaredActions: [{ block: 'invoicing', name: 'create_payment_link' }],
      actionExecutor,
      permissionEngine: { can: async () => true } as never,
    });
    const result = await graphql({
      schema,
      source: 'mutation { invoicing_create_payment_link }',
    });
    expect(result.errors?.[0]?.message).toContain('not installed');
    expect(result.errors?.[0]?.extensions?.code).toBe('not_found');
  });

  it('executes link/unlink mutations through the DataService link operations', async () => {
    const addLinks = vi.fn(async () => ({ added: 2 }));
    const removeLinks = vi.fn(async () => ({ removed: 1 }));
    const dataService = { addLinks, removeLinks } as unknown as DataService;

    const schema = buildGraphQLSchema(relationalRegistry(), dataService);
    const result = await graphql({
      schema,
      source:
        'mutation { link_contacts_tags(id: "c1", ids: ["t1", "t2"]) unlink_contacts_tags(id: "c1", ids: ["t3"]) }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ link_contacts_tags: 2, unlink_contacts_tags: 1 });
    expect(addLinks).toHaveBeenCalledWith('contacts', 'c1', 'tags', ['t1', 't2']);
    expect(removeLinks).toHaveBeenCalledWith('contacts', 'c1', 'tags', ['t3']);
  });
});

// ---------------------------------------------------------------------------
// Atomic increments + upsert (issue #9)
// ---------------------------------------------------------------------------

describe('increments and upsert (issue #9)', () => {
  it('reflects an IncrementInput with only numeric fields and an upsert mutation', () => {
    const sdl = printSchema(buildGraphQLSchema(registryWithContacts(), {} as DataService));

    expect(sdl).toContain('input ContactsIncrementInput');
    // Only the numeric field is incrementable.
    expect(sdl).toMatch(/input ContactsIncrementInput \{[^}]*age: Float/s);
    expect(sdl).not.toMatch(/input ContactsIncrementInput \{[^}]*full_name/s);
    // Update takes the parallel increment arg; input became nullable.
    expect(sdl).toMatch(
      /update_contacts\(id: ID!, input: ContactsUpdateInput, increment: ContactsIncrementInput\)/,
    );
    // Upsert mutation + result envelope.
    expect(sdl).toContain('type ContactsUpsertResult');
    expect(sdl).toMatch(
      /upsert_contacts\([^)]*input: ContactsCreateInput![\s\S]*?onConflict: \[String!\]!/,
    );
  });

  it('merges increment into the shared $inc operator path', async () => {
    const update = vi.fn(async (_o: string, _id: string, data: Record<string, unknown>) => ({
      data: { id: '1', full_name: 'Ada', age: 31, email_address: null },
    }));
    const dataService = { update } as unknown as DataService;
    const schema = buildGraphQLSchema(registryWithContacts(), dataService);

    const result = await graphql({
      schema,
      source: 'mutation { update_contacts(id: "1", increment: { age: 1 }) { age } }',
    });

    expect(result.errors).toBeUndefined();
    expect(update).toHaveBeenCalledWith('contacts', '1', { age: { $inc: 1 } });
  });

  it('rejects a field that is both set and incremented', async () => {
    const dataService = { update: vi.fn() } as unknown as DataService;
    const schema = buildGraphQLSchema(registryWithContacts(), dataService);

    const result = await graphql({
      schema,
      source:
        'mutation { update_contacts(id: "1", input: { age: 5 }, increment: { age: 1 }) { age } }',
    });

    expect(result.errors?.[0]?.message).toContain('cannot be both set');
  });

  it('rejects an update with neither input nor increment', async () => {
    const dataService = { update: vi.fn() } as unknown as DataService;
    const schema = buildGraphQLSchema(registryWithContacts(), dataService);

    const result = await graphql({
      schema,
      source: 'mutation { update_contacts(id: "1") { age } }',
    });

    expect(result.errors?.[0]?.message).toContain('at least one field');
  });

  it('executes upserts through the DataService and returns the created flag', async () => {
    const upsert = vi.fn(async () => ({
      data: { id: '1', full_name: 'Ada', age: 1, email_address: null },
      created: true,
    }));
    const dataService = { upsert } as unknown as DataService;
    const schema = buildGraphQLSchema(registryWithContacts(), dataService);

    const result = await graphql({
      schema,
      source:
        'mutation { upsert_contacts(input: { full_name: "Ada" }, onConflict: ["email"]) { created data { full_name } } }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      upsert_contacts: { created: true, data: { full_name: 'Ada' } },
    });
    expect(upsert).toHaveBeenCalledWith('contacts', { full_name: 'Ada' }, ['email']);
  });
});

// ---------------------------------------------------------------------------
// DataServiceError → typed GraphQL errors (issue #23)
// ---------------------------------------------------------------------------

describe('DataServiceError mapping (issue #23)', () => {
  it('surfaces upsert INVALID_CONFLICT_TARGET as a typed GraphQL error', async () => {
    const dataService = {
      upsert: vi.fn(async () => {
        throw new DataServiceError(
          'Upsert conflict target [age] must be the primary key, a unique field, or a uniqueTogether group',
          'INVALID_CONFLICT_TARGET',
          400,
        );
      }),
    } as unknown as DataService;
    const schema = buildGraphQLSchema(registryWithContacts(), dataService);

    const result = await graphql({
      schema,
      source:
        'mutation { upsert_contacts(input: { full_name: "Ada" }, onConflict: ["age"]) { created } }',
    });

    expect(result.data).toBeNull();
    const error = result.errors?.[0];
    expect(error?.extensions?.code).toBe('INVALID_CONFLICT_TARGET');
    expect(error?.message).toContain('conflict target');
    // A real GraphQLError with extensions — yoga's masking will let it through
    // instead of collapsing it to INTERNAL_SERVER_ERROR.
    expect(error).toBeInstanceOf(GraphQLError);
  });

  it('surfaces a translated unique violation (409) with its code and field', async () => {
    const dataService = {
      create: vi.fn(async () => {
        throw new DataServiceError(
          'A record with this email_address already exists',
          'unique_violation',
          409,
          'email_address',
        );
      }),
    } as unknown as DataService;
    const schema = buildGraphQLSchema(registryWithContacts(), dataService);

    const result = await graphql({
      schema,
      source: 'mutation { create_contacts(input: { full_name: "Ada" }) { id } }',
    });

    const error = result.errors?.[0];
    expect(error?.extensions?.code).toBe('unique_violation');
    expect(error?.extensions?.field).toBe('email_address');
    expect(error?.message).toBe('A record with this email_address already exists');
  });

  it('leaves non-DataServiceErrors untouched (they still mask as unexpected)', async () => {
    const dataService = {
      getById: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    } as unknown as DataService;
    const schema = buildGraphQLSchema(registryWithContacts(), dataService);

    const result = await graphql({
      schema,
      source: '{ contacts_by_id(id: "1") { id } }',
    });

    // graphql-js wraps it, but no platform code is attached — yoga will mask.
    expect(result.errors?.[0]?.extensions?.code).toBeUndefined();
  });
});
