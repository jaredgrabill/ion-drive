/**
 * Unit tests for `modify_object` validation (issue #9): replacing an object's
 * composite unique groups — group validity, live duplicate-data pre-checks on
 * added groups, delta-only DDL, and block contract protection.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeValidator } from './change-validator.js';
import type { DdlExecutor } from './ddl-executor.js';
import { SchemaRegistry } from './schema-registry.js';
import type { ChangeSet, DataObjectDefinition, ObjectConstraints } from './types.js';

function makeChangeSet(
  objectName: string,
  constraints: ObjectConstraints,
  force = false,
): ChangeSet {
  return {
    id: 'test',
    description: 'test',
    createdAt: new Date(),
    changes: [
      {
        type: 'modify_object',
        objectName,
        details: { constraints: constraints as Record<string, unknown>, force },
      },
    ],
  };
}

const matches: DataObjectDefinition = {
  name: 'matches',
  displayName: 'Matches',
  tableName: 'matches',
  fields: [
    { name: 'id', displayName: 'ID', columnName: 'id', columnType: 'uuid', isSystem: true },
    { name: 'room_code', displayName: 'Room', columnName: 'room_code', columnType: 'text' },
    { name: 'seed', displayName: 'Seed', columnName: 'seed', columnType: 'integer' },
    { name: 'mode', displayName: 'Mode', columnName: 'mode', columnType: 'text' },
  ],
  constraints: { uniqueTogether: [['mode', 'room_code']] },
};

describe('ChangeValidator — modify_object (uniqueTogether)', () => {
  let registry: SchemaRegistry;
  let ddl: { findDuplicateGroupValues: ReturnType<typeof vi.fn> };
  let validator: ChangeValidator;

  beforeEach(() => {
    registry = new SchemaRegistry();
    registry.registerObject(structuredClone(matches));
    ddl = { findDuplicateGroupValues: vi.fn().mockResolvedValue([]) };
    validator = new ChangeValidator(registry, ddl as unknown as DdlExecutor);
  });

  it('previews delta DDL: drops removed groups, adds new ones, keeps the rest', async () => {
    const preview = await validator.validateChangeSet(
      makeChangeSet('matches', {
        uniqueTogether: [
          ['mode', 'room_code'],
          ['room_code', 'seed'],
        ],
      }),
    );

    expect(preview.isValid).toBe(true);
    expect(preview.sqlStatements).toEqual([
      'ALTER TABLE "matches" ADD CONSTRAINT "ion_uq_matches_room_code_seed" UNIQUE ("room_code", "seed")',
    ]);
    // Only the added group is data-prechecked.
    expect(ddl.findDuplicateGroupValues).toHaveBeenCalledTimes(1);
    expect(ddl.findDuplicateGroupValues).toHaveBeenCalledWith('matches', ['room_code', 'seed']);
  });

  it('previews the DROP CONSTRAINT for removed groups', async () => {
    const preview = await validator.validateChangeSet(
      makeChangeSet('matches', { uniqueTogether: [] }),
    );
    expect(preview.isValid).toBe(true);
    expect(preview.sqlStatements[0]).toContain('DROP CONSTRAINT');
    expect(preview.sqlStatements[0]).toContain('ion_uq_matches_mode_room_code');
  });

  it('fails with named samples when the added group has duplicate data', async () => {
    ddl.findDuplicateGroupValues.mockResolvedValue([{ values: 'alpha, 7', count: 3 }]);
    const preview = await validator.validateChangeSet(
      makeChangeSet('matches', { uniqueTogether: [['room_code', 'seed']] }),
    );

    expect(preview.isValid).toBe(false);
    expect(preview.errors[0]?.code).toBe('DUPLICATE_VALUES');
    expect(preview.errors[0]?.message).toContain('(alpha, 7) ×3');
  });

  it('rejects invalid groups (unknown field, too small)', async () => {
    const preview = await validator.validateChangeSet(
      makeChangeSet('matches', { uniqueTogether: [['room_code', 'ghost'], ['seed']] }),
    );
    expect(preview.isValid).toBe(false);
    const codes = preview.errors.map((e) => e.code);
    expect(codes).toEqual(['INVALID_UNIQUE_TOGETHER', 'INVALID_UNIQUE_TOGETHER']);
  });

  it('rejects unknown objects', async () => {
    const preview = await validator.validateChangeSet(makeChangeSet('ghost', {}));
    expect(preview.errors[0]?.code).toBe('OBJECT_NOT_FOUND');
  });

  it('protects block-managed objects unless forced (ADR-017)', async () => {
    registry.registerObject({ ...structuredClone(matches), managedBy: 'block:arena' });

    const blocked = await validator.validateChangeSet(
      makeChangeSet('matches', { uniqueTogether: [['room_code', 'seed']] }),
    );
    expect(blocked.isValid).toBe(false);
    expect(blocked.errors[0]?.code).toBe('BLOCK_MANAGED_OBJECT');

    const forced = await validator.validateChangeSet(
      makeChangeSet('matches', { uniqueTogether: [['room_code', 'seed']] }, true),
    );
    expect(forced.isValid).toBe(true);
    expect(forced.warnings.some((w) => w.message.includes('arena'))).toBe(true);
  });
});
