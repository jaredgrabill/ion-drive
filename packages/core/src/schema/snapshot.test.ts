/**
 * Unit tests for schema snapshot export/diff (Phase 10 / 4A).
 */

import { describe, expect, it } from 'vitest';
import { type SchemaSnapshot, diffSnapshot, exportSnapshot } from './snapshot.js';
import type { DataObjectDefinition } from './types.js';

const contacts: DataObjectDefinition = {
  name: 'contacts',
  displayName: 'Contacts',
  tableName: 'contacts',
  fields: [
    {
      name: 'id',
      displayName: 'ID',
      columnName: 'id',
      columnType: 'uuid',
      isSystem: true,
      isPrimary: true,
    },
    {
      name: 'email',
      displayName: 'Email',
      columnName: 'email',
      columnType: 'email',
      isRequired: true,
      sortOrder: 1,
    },
    {
      name: 'stage',
      displayName: 'Stage',
      columnName: 'stage',
      columnType: 'enum',
      constraints: { enumValues: ['lead', 'won'] },
      sortOrder: 2,
    },
    // FK created by the "company" relationship — must not export as a plain field
    {
      name: 'company_id',
      displayName: 'Company ID',
      columnName: 'company_id',
      columnType: 'uuid',
      isIndexed: true,
    },
  ],
  relationships: [
    {
      name: 'company',
      displayName: 'Company',
      type: 'many_to_one',
      sourceObjectName: 'contacts',
      targetObjectName: 'companies',
    },
  ],
};

describe('exportSnapshot', () => {
  it('exports user fields, skipping system fields and relationship FK columns', () => {
    const snapshot = exportSnapshot([contacts]);
    const fieldNames = snapshot.objects[0]?.fields.map((f) => f.name);
    expect(fieldNames).toEqual(['email', 'stage']);
    expect(snapshot.relationships.map((r) => r.name)).toEqual(['company']);
    expect(snapshot.formatVersion).toBe(1);
  });

  it('round-trips to an empty diff against the same state', () => {
    const snapshot = exportSnapshot([contacts]);
    expect(diffSnapshot(snapshot, [contacts])).toEqual([]);
  });
});

describe('diffSnapshot', () => {
  function snapshotOf(...objects: DataObjectDefinition[]): SchemaSnapshot {
    return exportSnapshot(objects);
  }

  it('creates missing objects and relationships', () => {
    const snapshot = snapshotOf(contacts);
    const entries = diffSnapshot(snapshot, []);
    expect(entries.map((e) => e.kind)).toEqual(['create_object', 'add_relationship']);
  });

  it('adds missing fields and modifies changed ones', () => {
    const snapshot = snapshotOf(contacts);
    const drifted: DataObjectDefinition = {
      ...contacts,
      relationships: contacts.relationships,
      fields: contacts.fields
        .filter((f) => f.name !== 'stage') // stage missing → add_field
        .map((f) => (f.name === 'email' ? { ...f, isRequired: false, displayName: 'E-mail' } : f)),
    };
    const entries = diffSnapshot(snapshot, [drifted]);
    const kinds = Object.fromEntries(entries.map((e) => [e.kind, e]));

    expect(kinds.add_field?.fieldName).toBe('stage');
    expect(kinds.modify_field?.fieldName).toBe('email');
    expect(kinds.modify_field?.updates).toMatchObject({
      isRequired: true,
      displayName: 'Email',
    });
  });

  it('detects constraint changes structurally (key order does not matter)', () => {
    const snapshot = snapshotOf(contacts);
    const sameButReordered: DataObjectDefinition = {
      ...contacts,
      fields: contacts.fields.map((f) =>
        f.name === 'stage'
          ? { ...f, constraints: { enumValues: ['lead', 'won'] } } // same content
          : f,
      ),
    };
    expect(diffSnapshot(snapshot, [sameButReordered])).toEqual([]);

    const changed: DataObjectDefinition = {
      ...contacts,
      fields: contacts.fields.map((f) =>
        f.name === 'stage' ? { ...f, constraints: { enumValues: ['lead'] } } : f,
      ),
    };
    const entries = diffSnapshot(snapshot, [changed]);
    expect(entries[0]?.updates?.constraints).toEqual({ enumValues: ['lead', 'won'] });
  });

  it('only prunes when asked', () => {
    const snapshot = snapshotOf(contacts);
    const extraField: DataObjectDefinition = {
      ...contacts,
      fields: [
        ...contacts.fields,
        { name: 'legacy', displayName: 'Legacy', columnName: 'legacy', columnType: 'text' },
      ],
    };
    expect(diffSnapshot(snapshot, [extraField])).toEqual([]);
    const pruned = diffSnapshot(snapshot, [extraField], { prune: true });
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toMatchObject({ kind: 'remove_field', fieldName: 'legacy' });
  });

  it('prunes relationships absent from the snapshot (Phase 13)', () => {
    const snapshot = snapshotOf({ ...contacts, relationships: [] });
    // The FK field must also disappear from the snapshot's view of contacts.
    snapshot.objects[0]!.fields = snapshot.objects[0]!.fields.filter(
      (f) => f.name !== 'company_id',
    );

    expect(diffSnapshot(snapshot, [contacts]).map((e) => e.kind)).toEqual([]);
    const pruned = diffSnapshot(snapshot, [contacts], { prune: true });
    expect(pruned).toContainEqual(
      expect.objectContaining({
        kind: 'remove_relationship',
        objectName: 'contacts',
        relationshipName: 'company',
      }),
    );
  });

  it('matches relationships by their (source, name) pair, not name alone', () => {
    // Two relationships legitimately named "company" from different sources.
    const dealsRel = {
      name: 'company',
      displayName: 'Company',
      type: 'many_to_one' as const,
      sourceObjectName: 'deals',
      targetObjectName: 'companies',
    };
    const deals: DataObjectDefinition = {
      name: 'deals',
      displayName: 'Deals',
      tableName: 'deals',
      fields: [
        { name: 'id', displayName: 'ID', columnName: 'id', columnType: 'uuid', isSystem: true },
      ],
      relationships: [dealsRel],
    };

    const snapshot = exportSnapshot([contacts, deals]);
    expect(snapshot.relationships).toHaveLength(2);

    // Live state has only contacts' rel — deals' must still be added.
    const entries = diffSnapshot(snapshot, [contacts, { ...deals, relationships: [] }]);
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'add_relationship', objectName: 'deals' }),
    );
  });
});
