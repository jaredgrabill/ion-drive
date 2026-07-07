/**
 * Unit tests for `remove_relationship` validation (Phase 13 / F17): source
 * scoping, real DDL statements, data-loss warnings, and block contract
 * protection (FK-field provenance / block-owned endpoints + force).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeValidator } from './change-validator.js';
import type { DdlExecutor } from './ddl-executor.js';
import { SchemaRegistry } from './schema-registry.js';
import type { ChangeSet, DataObjectDefinition, RelationshipDefinition } from './types.js';

function makeChangeSet(objectName: string, relationshipName: string, force = false): ChangeSet {
  return {
    id: 'test',
    description: 'test',
    createdAt: new Date(),
    changes: [{ type: 'remove_relationship', objectName, details: { relationshipName, force } }],
  };
}

const companyRel: RelationshipDefinition = {
  id: 'rel-1',
  name: 'company',
  displayName: 'Company',
  type: 'many_to_one',
  sourceObjectName: 'contacts',
  targetObjectName: 'companies',
};

const tagsRel: RelationshipDefinition = {
  id: 'rel-2',
  name: 'tags',
  displayName: 'Tags',
  type: 'many_to_many',
  sourceObjectName: 'contacts',
  targetObjectName: 'tags',
  junctionTable: 'contacts_tags',
  junctionSourceColumn: 'contacts_id',
  junctionTargetColumn: 'tags_id',
};

function objects(managedByBlock: boolean): DataObjectDefinition[] {
  return [
    {
      name: 'contacts',
      displayName: 'Contacts',
      tableName: 'contacts',
      managedBy: managedByBlock ? 'block:crm' : 'user',
      fields: [
        { name: 'id', displayName: 'ID', columnName: 'id', columnType: 'uuid', isSystem: true },
        {
          id: 'f-fk',
          name: 'company_id',
          displayName: 'Company ID',
          columnName: 'company_id',
          columnType: 'uuid',
          managedBy: managedByBlock ? 'block:crm' : undefined,
        },
      ],
      relationships: [companyRel, tagsRel],
    },
    {
      name: 'companies',
      displayName: 'Companies',
      tableName: 'companies',
      managedBy: managedByBlock ? 'block:crm' : 'user',
      fields: [
        { name: 'id', displayName: 'ID', columnName: 'id', columnType: 'uuid', isSystem: true },
      ],
      relationships: [companyRel],
    },
    {
      name: 'tags',
      displayName: 'Tags',
      tableName: 'tags',
      managedBy: managedByBlock ? 'block:crm' : 'user',
      fields: [
        { name: 'id', displayName: 'ID', columnName: 'id', columnType: 'uuid', isSystem: true },
      ],
      relationships: [tagsRel],
    },
  ];
}

describe('ChangeValidator — remove_relationship', () => {
  let ddl: {
    columnHasData: ReturnType<typeof vi.fn>;
    tableExists: ReturnType<typeof vi.fn>;
    getRowCount: ReturnType<typeof vi.fn>;
  };

  function makeValidator(blockManaged = false): ChangeValidator {
    const registry = new SchemaRegistry();
    for (const obj of objects(blockManaged)) registry.registerObject(structuredClone(obj));
    return new ChangeValidator(registry, ddl as unknown as DdlExecutor);
  }

  beforeEach(() => {
    ddl = {
      columnHasData: vi.fn().mockResolvedValue(false),
      tableExists: vi.fn().mockResolvedValue(true),
      getRowCount: vi.fn().mockResolvedValue(0),
    };
  });

  it('produces the FK column drop for a FK-backed relationship', async () => {
    const preview = await makeValidator().validateChangeSet(makeChangeSet('contacts', 'company'));
    expect(preview.isValid).toBe(true);
    expect(preview.warnings).toHaveLength(0);
    expect(preview.sqlStatements).toEqual(['ALTER TABLE "contacts" DROP COLUMN "company_id"']);
  });

  it('warns about stored links when the FK column has data', async () => {
    ddl.columnHasData.mockResolvedValue(true);
    const preview = await makeValidator().validateChangeSet(makeChangeSet('contacts', 'company'));
    expect(preview.isValid).toBe(true);
    expect(preview.warnings[0]?.message).toContain('company_id');
    expect(preview.warnings[0]?.severity).toBe('high');
  });

  it('produces the junction drop and counts doomed links for many_to_many', async () => {
    ddl.getRowCount.mockResolvedValue(7);
    const preview = await makeValidator().validateChangeSet(makeChangeSet('contacts', 'tags'));
    expect(preview.isValid).toBe(true);
    expect(preview.sqlStatements).toEqual(['DROP TABLE IF EXISTS "contacts_tags"']);
    expect(preview.warnings[0]?.message).toContain('7 link row(s)');
  });

  it('scopes lookup to the source object', async () => {
    // "company" exists, but its source is contacts — not companies.
    const preview = await makeValidator().validateChangeSet(makeChangeSet('companies', 'company'));
    expect(preview.isValid).toBe(false);
    expect(preview.errors[0]?.code).toBe('RELATIONSHIP_NOT_FOUND');
  });

  it('protects a block-owned FK relationship unless forced', async () => {
    const validator = makeValidator(true);

    const blocked = await validator.validateChangeSet(makeChangeSet('contacts', 'company'));
    expect(blocked.isValid).toBe(false);
    expect(blocked.errors[0]?.code).toBe('BLOCK_MANAGED_RELATIONSHIP');
    expect(blocked.errors[0]?.message).toContain('crm');

    const forced = await validator.validateChangeSet(makeChangeSet('contacts', 'company', true));
    expect(forced.isValid).toBe(true);
    expect(forced.warnings.some((w) => w.severity === 'high' && w.message.includes('crm'))).toBe(
      true,
    );
  });

  it('protects a many_to_many between two block-managed objects unless forced', async () => {
    const validator = makeValidator(true);
    const blocked = await validator.validateChangeSet(makeChangeSet('contacts', 'tags'));
    expect(blocked.isValid).toBe(false);
    expect(blocked.errors[0]?.code).toBe('BLOCK_MANAGED_RELATIONSHIP');
  });
});
