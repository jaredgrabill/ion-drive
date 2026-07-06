/** Unit tests for the record display-label helpers. */

import { describe, expect, it } from 'vitest';
import { displayFieldOf, recordLabelOf } from './record-label';
import type { DataObjectDefinition, FieldDefinition } from './types';

function field(overrides: Partial<FieldDefinition> & { name: string }): FieldDefinition {
  return {
    displayName: overrides.name,
    columnName: overrides.name,
    columnType: 'text',
    ...overrides,
  };
}

function object(fields: FieldDefinition[]): DataObjectDefinition {
  return { name: 'contacts', displayName: 'Contacts', tableName: 'contacts', fields };
}

describe('displayFieldOf', () => {
  it('prefers the explicit override', () => {
    const obj = object([field({ name: 'name' })]);
    expect(displayFieldOf(obj, 'email')).toBe('email');
  });

  it('picks the first non-system text-like field', () => {
    const obj = object([
      field({ name: 'id', columnType: 'uuid', isPrimary: true }),
      field({ name: 'created_at', columnType: 'timestamp', isSystem: true }),
      field({ name: 'age', columnType: 'integer' }),
      field({ name: 'email', columnType: 'email' }),
      field({ name: 'name', columnType: 'text' }),
    ]);
    expect(displayFieldOf(obj)).toBe('email');
  });

  it('treats enum fields as text-like', () => {
    const obj = object([
      field({ name: 'count', columnType: 'integer' }),
      field({ name: 'status', columnType: 'enum' }),
    ]);
    expect(displayFieldOf(obj)).toBe('status');
  });

  it('skips system and primary fields even when text-like', () => {
    const obj = object([
      field({ name: 'slug', columnType: 'slug', isPrimary: true }),
      field({ name: 'note', columnType: 'long_text', isSystem: true }),
    ]);
    expect(displayFieldOf(obj)).toBe('id');
  });

  it('falls back to id for an undefined object or no text fields', () => {
    expect(displayFieldOf(undefined)).toBe('id');
    expect(displayFieldOf(object([field({ name: 'n', columnType: 'integer' })]))).toBe('id');
  });
});

describe('recordLabelOf', () => {
  it('returns the display-field value as a string', () => {
    expect(recordLabelOf({ id: 'abc', name: 'Acme Corp' }, 'name')).toBe('Acme Corp');
    expect(recordLabelOf({ id: 'abc', count: 42 }, 'count')).toBe('42');
  });

  it('falls back to a truncated id when the value is empty or missing', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(recordLabelOf({ id, name: '' }, 'name')).toBe('123e4567…');
    expect(recordLabelOf({ id, name: null }, 'name')).toBe('123e4567…');
    expect(recordLabelOf({ id }, 'name')).toBe('123e4567…');
  });

  it('returns a dash when there is no record or id at all', () => {
    expect(recordLabelOf(undefined, 'name')).toBe('—');
    expect(recordLabelOf({}, 'name')).toBe('—');
  });
});
