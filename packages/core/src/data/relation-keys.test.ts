import { describe, expect, it } from 'vitest';
import type { DataObjectDefinition, RelationshipDefinition } from '../schema/types.js';
import { findRelationKey, listRelationKeys } from './relation-keys.js';

function obj(
  name: string,
  relationships: RelationshipDefinition[],
  fieldNames: string[] = [],
): DataObjectDefinition {
  return {
    name,
    displayName: name,
    tableName: name,
    fields: fieldNames.map((f) => ({
      name: f,
      displayName: f,
      columnName: f,
      columnType: 'text',
    })),
    relationships,
  } as DataObjectDefinition;
}

const manyToOne: RelationshipDefinition = {
  name: 'company',
  displayName: 'Company',
  type: 'many_to_one',
  sourceObjectName: 'contacts',
  targetObjectName: 'companies',
};

const oneToMany: RelationshipDefinition = {
  name: 'owner',
  displayName: 'Owner',
  type: 'one_to_many',
  sourceObjectName: 'users',
  targetObjectName: 'tickets',
};

const oneToOne: RelationshipDefinition = {
  name: 'profile_user',
  displayName: 'User',
  type: 'one_to_one',
  sourceObjectName: 'profiles',
  targetObjectName: 'users',
};

const manyToMany: RelationshipDefinition = {
  name: 'tags',
  displayName: 'Tags',
  type: 'many_to_many',
  sourceObjectName: 'contacts',
  targetObjectName: 'tags',
  junctionTable: 'contacts_tags',
  junctionSourceColumn: 'contacts_id',
  junctionTargetColumn: 'tags_id',
};

describe('listRelationKeys', () => {
  it('yields the FK-side single key on the FK-holding object (many_to_one source)', () => {
    const keys = listRelationKeys(obj('contacts', [manyToOne]));
    expect(keys).toEqual([
      expect.objectContaining({
        key: 'company',
        kind: 'single',
        otherObject: 'companies',
        via: 'fk',
      }),
    ]);
  });

  it('yields the reverse list key on the "one" side (many_to_one target)', () => {
    const keys = listRelationKeys(obj('companies', [manyToOne]));
    expect(keys).toEqual([
      expect.objectContaining({
        key: 'contacts_by_company',
        kind: 'list',
        otherObject: 'contacts',
        via: 'reverse',
      }),
    ]);
  });

  it('puts the FK single key on the one_to_many target and the reverse list on its source', () => {
    expect(listRelationKeys(obj('tickets', [oneToMany]))).toEqual([
      expect.objectContaining({ key: 'owner', kind: 'single', otherObject: 'users', via: 'fk' }),
    ]);
    expect(listRelationKeys(obj('users', [oneToMany]))).toEqual([
      expect.objectContaining({
        key: 'tickets_by_owner',
        kind: 'list',
        otherObject: 'tickets',
        via: 'reverse',
      }),
    ]);
  });

  it('keeps the reverse of a one_to_one single', () => {
    expect(listRelationKeys(obj('users', [oneToOne]))).toEqual([
      expect.objectContaining({
        key: 'profiles_by_profile_user',
        kind: 'single',
        otherObject: 'profiles',
        via: 'reverse',
      }),
    ]);
  });

  it('yields the same many_to_many list key from either side', () => {
    expect(listRelationKeys(obj('contacts', [manyToMany]))).toEqual([
      expect.objectContaining({ key: 'tags', kind: 'list', otherObject: 'tags', via: 'junction' }),
    ]);
    expect(listRelationKeys(obj('tags', [manyToMany]))).toEqual([
      expect.objectContaining({
        key: 'tags',
        kind: 'list',
        otherObject: 'contacts',
        via: 'junction',
      }),
    ]);
  });

  it('yields both sides of a self-referential FK relationship', () => {
    const manager: RelationshipDefinition = {
      name: 'manager',
      displayName: 'Manager',
      type: 'many_to_one',
      sourceObjectName: 'contacts',
      targetObjectName: 'contacts',
    };
    const keys = listRelationKeys(obj('contacts', [manager]));
    expect(keys.map((k) => k.key)).toEqual(['manager', 'contacts_by_manager']);
    expect(keys[0]).toMatchObject({ kind: 'single', via: 'fk' });
    expect(keys[1]).toMatchObject({ kind: 'list', via: 'reverse' });
  });

  it('drops a relation key that collides with a column field name', () => {
    const keys = listRelationKeys(obj('contacts', [manyToOne], ['company']));
    expect(keys).toEqual([]);
  });
});

describe('findRelationKey', () => {
  it('finds by public key including reverse keys', () => {
    const key = findRelationKey(obj('companies', [manyToOne]), 'contacts_by_company');
    expect(key?.via).toBe('reverse');
    expect(findRelationKey(obj('companies', [manyToOne]), 'nope')).toBeUndefined();
  });
});
