import { graphql, printSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { DataService } from '../../data/data-service.js';
import { SchemaRegistry } from '../../schema/schema-registry.js';
import type { DataObjectDefinition } from '../../schema/types.js';
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
