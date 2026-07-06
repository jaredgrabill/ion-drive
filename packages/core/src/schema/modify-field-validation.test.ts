/**
 * Unit tests for `modify_field`/`remove_field` validation (Phase 10):
 * type-change safety, unique/required data pre-checks, rename checks, and
 * block contract protection (`managedBy` + force).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeValidator } from './change-validator.js';
import type { DdlExecutor } from './ddl-executor.js';
import { SchemaRegistry } from './schema-registry.js';
import type { ChangeSet, DataObjectDefinition, FieldModification } from './types.js';

function makeChangeSet(
  objectName: string,
  fieldName: string,
  updates: FieldModification,
  force = false,
): ChangeSet {
  return {
    id: 'test',
    description: 'test',
    createdAt: new Date(),
    changes: [
      {
        type: 'modify_field',
        objectName,
        details: { fieldName, updates: updates as Record<string, unknown>, force },
      },
    ],
  };
}

const contacts: DataObjectDefinition = {
  name: 'contacts',
  displayName: 'Contacts',
  tableName: 'contacts',
  fields: [
    { name: 'id', displayName: 'ID', columnName: 'id', columnType: 'uuid', isSystem: true },
    { name: 'email', displayName: 'Email', columnName: 'email', columnType: 'email' },
    { name: 'bio', displayName: 'Bio', columnName: 'bio', columnType: 'text' },
    { name: 'age', displayName: 'Age', columnName: 'age', columnType: 'big_integer' },
    {
      name: 'status',
      displayName: 'Status',
      columnName: 'status',
      columnType: 'enum',
      managedBy: 'block:crm',
    },
  ],
};

describe('ChangeValidator — modify_field', () => {
  let registry: SchemaRegistry;
  let ddl: {
    getMaxTextLength: ReturnType<typeof vi.fn>;
    countOutOfRange: ReturnType<typeof vi.fn>;
    countNulls: ReturnType<typeof vi.fn>;
    findDuplicateValues: ReturnType<typeof vi.fn>;
  };
  let validator: ChangeValidator;

  beforeEach(() => {
    registry = new SchemaRegistry();
    registry.registerObject(structuredClone(contacts));
    ddl = {
      getMaxTextLength: vi.fn().mockResolvedValue(0),
      countOutOfRange: vi.fn().mockResolvedValue(0),
      countNulls: vi.fn().mockResolvedValue(0),
      findDuplicateValues: vi.fn().mockResolvedValue([]),
    };
    validator = new ChangeValidator(registry, ddl as unknown as DdlExecutor);
  });

  it('accepts a safe widening type change without warnings', async () => {
    const preview = await validator.validateChangeSet(
      makeChangeSet('contacts', 'email', { columnType: 'text' }),
    );
    expect(preview.isValid).toBe(true);
    expect(preview.warnings).toHaveLength(0);
    expect(preview.sqlStatements.join('\n')).toContain('ALTER COLUMN "email" TYPE TEXT');
  });

  it('warns on narrowing and errors when existing data would not fit', async () => {
    ddl.getMaxTextLength.mockResolvedValue(900);
    const preview = await validator.validateChangeSet(
      makeChangeSet('contacts', 'bio', { columnType: 'short_text' }),
    );
    expect(preview.isValid).toBe(false);
    expect(preview.errors[0]?.code).toBe('DATA_INCOMPATIBLE');
    expect(preview.errors[0]?.message).toContain('900');
  });

  it('errors on incompatible type pairs', async () => {
    const preview = await validator.validateChangeSet(
      makeChangeSet('contacts', 'bio', { columnType: 'integer' }),
    );
    expect(preview.isValid).toBe(false);
    expect(preview.errors[0]?.code).toBe('TYPE_INCOMPATIBLE');
  });

  it('runs the numeric range pre-check when narrowing numbers', async () => {
    ddl.countOutOfRange.mockResolvedValue(3);
    const preview = await validator.validateChangeSet(
      makeChangeSet('contacts', 'age', { columnType: 'integer' }),
    );
    expect(preview.isValid).toBe(false);
    expect(preview.errors[0]?.message).toContain('3 existing row(s)');
  });

  it('rejects unique toggles when duplicates exist, naming the offenders', async () => {
    ddl.findDuplicateValues.mockResolvedValue([{ value: 'a@b.co', count: 2 }]);
    const preview = await validator.validateChangeSet(
      makeChangeSet('contacts', 'email', { isUnique: true }),
    );
    expect(preview.isValid).toBe(false);
    expect(preview.errors[0]?.code).toBe('DUPLICATE_VALUES');
    expect(preview.errors[0]?.message).toContain('a@b.co');
  });

  it('requires a backfill value when making a column with NULLs required', async () => {
    ddl.countNulls.mockResolvedValue(4);
    const noBackfill = await validator.validateChangeSet(
      makeChangeSet('contacts', 'email', { isRequired: true }),
    );
    expect(noBackfill.isValid).toBe(false);
    expect(noBackfill.errors[0]?.code).toBe('REQUIRES_BACKFILL');

    const withBackfill = await validator.validateChangeSet(
      makeChangeSet('contacts', 'email', { isRequired: true, backfillValue: 'none@example.com' }),
    );
    expect(withBackfill.isValid).toBe(true);
    expect(withBackfill.warnings.some((w) => w.message.includes('4 row(s)'))).toBe(true);
  });

  it('warns that renames change the public API surface', async () => {
    const preview = await validator.validateChangeSet(
      makeChangeSet('contacts', 'bio', { name: 'biography' }),
    );
    expect(preview.isValid).toBe(true);
    expect(preview.warnings[0]?.message).toContain('REST filter keys');
  });

  it('rejects renames to existing or invalid names', async () => {
    const duplicate = await validator.validateChangeSet(
      makeChangeSet('contacts', 'bio', { name: 'email' }),
    );
    expect(duplicate.errors[0]?.code).toBe('FIELD_EXISTS');

    const invalid = await validator.validateChangeSet(
      makeChangeSet('contacts', 'bio', { name: 'Bad Name' }),
    );
    expect(invalid.errors[0]?.code).toBe('INVALID_NAME');
  });

  it('rejects modification of system fields', async () => {
    const preview = await validator.validateChangeSet(
      makeChangeSet('contacts', 'id', { displayName: 'Identifier' }),
    );
    expect(preview.isValid).toBe(false);
    expect(preview.errors[0]?.code).toBe('CANNOT_MODIFY_SYSTEM_FIELD');
  });

  describe('block contract protection', () => {
    it('rejects structural changes to block-managed fields, naming the block', async () => {
      const preview = await validator.validateChangeSet(
        makeChangeSet('contacts', 'status', { columnType: 'text' }),
      );
      expect(preview.isValid).toBe(false);
      expect(preview.errors[0]?.code).toBe('BLOCK_MANAGED_FIELD');
      expect(preview.errors[0]?.message).toContain('"crm"');
    });

    it('allows presentation-only changes to block-managed fields', async () => {
      const preview = await validator.validateChangeSet(
        makeChangeSet('contacts', 'status', {
          displayName: 'Deal Status',
          description: 'Where the deal is',
          isIndexed: true,
        }),
      );
      expect(preview.isValid).toBe(true);
    });

    it('downgrades the rejection to a high-severity warning when forced', async () => {
      const preview = await validator.validateChangeSet(
        makeChangeSet('contacts', 'status', { columnType: 'text' }, true),
      );
      expect(preview.isValid).toBe(true);
      expect(preview.warnings.some((w) => w.severity === 'high' && w.message.includes('crm'))).toBe(
        true,
      );
    });

    it('protects block-managed fields from removal without force', async () => {
      const changeSet: ChangeSet = {
        id: 't',
        description: 't',
        createdAt: new Date(),
        changes: [
          { type: 'remove_field', objectName: 'contacts', details: { fieldName: 'status' } },
        ],
      };
      const ddlWithData = {
        ...ddl,
        columnHasData: vi.fn().mockResolvedValue(false),
      };
      const v = new ChangeValidator(registry, ddlWithData as unknown as DdlExecutor);
      const preview = await v.validateChangeSet(changeSet);
      expect(preview.isValid).toBe(false);
      expect(preview.errors[0]?.code).toBe('BLOCK_MANAGED_FIELD');
    });
  });
});
