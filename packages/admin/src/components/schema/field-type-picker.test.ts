/**
 * Unit tests for Phase 10 designer helpers: storage blurbs (type-picker full
 * disclosure) and linked-relationship detection (Tier 3 link fields).
 */

import { describe, expect, it } from 'vitest';
import type { DataObjectDefinition, FieldDefinition } from '../../lib/types';
import { linkTargetOf, linkedRelationshipOf } from '../data/grid-types';
import { storageBlurb } from './field-type-picker';

describe('storageBlurb', () => {
  it('reads VARCHAR limits into plain words', () => {
    expect(storageBlurb('VARCHAR(255)')).toBe('up to 255 characters');
    expect(storageBlurb('VARCHAR(2048)')).toBe('up to 2,048 characters');
  });

  it('describes the common PG types', () => {
    expect(storageBlurb('TEXT')).toBe('unlimited length');
    expect(storageBlurb('BIGINT')).toContain('9.2 quintillion');
    expect(storageBlurb('TIMESTAMPTZ')).toContain('timezone');
  });
});

describe('linkedRelationshipOf', () => {
  const contacts: DataObjectDefinition = {
    name: 'contacts',
    displayName: 'Contacts',
    tableName: 'contacts',
    fields: [],
    relationships: [
      {
        name: 'company',
        displayName: 'Company',
        type: 'many_to_one',
        sourceObjectName: 'contacts',
        targetObjectName: 'companies',
      },
      {
        name: 'tags',
        displayName: 'Tags',
        type: 'many_to_many',
        sourceObjectName: 'contacts',
        targetObjectName: 'tags',
      },
    ],
  };
  const fkField: FieldDefinition = {
    name: 'company_id',
    displayName: 'Company ID',
    columnName: 'company_id',
    columnType: 'uuid',
  };

  it('resolves the relationship behind a FK column on this object', () => {
    const rel = linkedRelationshipOf(contacts, fkField);
    expect(rel?.name).toBe('company');
    expect(rel && linkTargetOf(contacts, rel)).toBe('companies');
  });

  it('ignores plain uuid fields and many_to_many relationships', () => {
    expect(
      linkedRelationshipOf(contacts, {
        ...fkField,
        name: 'external_id',
        columnName: 'external_id',
      }),
    ).toBeNull();
    expect(
      linkedRelationshipOf(contacts, { ...fkField, name: 'tags_id', columnName: 'tags_id' }),
    ).toBeNull();
  });
});
