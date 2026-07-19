/**
 * Unit tests for composite unique-constraint helpers (issue #9): group
 * resolution/normalization, delta computation, conflict-target matching, and
 * the rendered DDL/constraint names.
 */

import { describe, expect, it } from 'vitest';
import { renderAddUniqueConstraint, uniqueConstraintName } from './ddl-executor.js';
import type { FieldDefinition } from './types.js';
import {
  diffUniqueTogether,
  groupKey,
  matchesUniqueTogether,
  resolveUniqueTogether,
} from './unique-together.js';

const fields: FieldDefinition[] = [
  { name: 'room_code', displayName: 'Room', columnName: 'room_code', columnType: 'text' },
  { name: 'seed', displayName: 'Seed', columnName: 'seed', columnType: 'integer' },
  { name: 'player', displayName: 'Player', columnName: 'player_col', columnType: 'text' },
];

describe('resolveUniqueTogether', () => {
  it('normalizes groups: column names resolved, sorted within and across groups', () => {
    const { groups, errors } = resolveUniqueTogether(
      [
        ['seed', 'room_code'],
        ['player', 'seed'],
      ],
      fields,
    );
    expect(errors).toEqual([]);
    // "player" resolves to its physical column, groups come back sorted.
    expect(groups).toEqual([
      ['player_col', 'seed'],
      ['room_code', 'seed'],
    ]);
  });

  it('rejects groups with fewer than two fields, pointing at isUnique', () => {
    const { errors } = resolveUniqueTogether([['seed']], fields);
    expect(errors[0]).toContain('at least two fields');
    expect(errors[0]).toContain('isUnique');
  });

  it('rejects unknown fields by name', () => {
    const { errors } = resolveUniqueTogether([['seed', 'ghost']], fields);
    expect(errors[0]).toContain('"ghost"');
  });

  it('rejects duplicate columns within a group and duplicate groups', () => {
    const dupCol = resolveUniqueTogether([['seed', 'seed']], fields);
    expect(dupCol.errors[0]).toContain('duplicate fields');

    const dupGroup = resolveUniqueTogether(
      [
        ['room_code', 'seed'],
        ['seed', 'room_code'],
      ],
      fields,
    );
    expect(dupGroup.errors[0]).toContain('more than once');
  });

  it('returns empty groups for undefined input', () => {
    expect(resolveUniqueTogether(undefined, fields)).toEqual({ groups: [], errors: [] });
  });
});

describe('diffUniqueTogether', () => {
  it('computes the added/removed delta order-insensitively', () => {
    const { added, removed } = diffUniqueTogether(
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      [
        ['b', 'a'],
        ['e', 'f'],
      ],
    );
    expect(added).toEqual([['e', 'f']]);
    expect(removed).toEqual([['c', 'd']]);
  });
});

describe('matchesUniqueTogether', () => {
  it('matches a group regardless of column order', () => {
    const groups = [['room_code', 'seed']];
    expect(matchesUniqueTogether(['seed', 'room_code'], groups)).toBe(true);
    expect(matchesUniqueTogether(['room_code'], groups)).toBe(false);
    expect(matchesUniqueTogether(['room_code', 'seed', 'x'], groups)).toBe(false);
  });
});

describe('constraint rendering', () => {
  it('names constraints deterministically and quotes every column', () => {
    expect(uniqueConstraintName('matches', ['room_code', 'seed'])).toBe(
      'ion_uq_matches_room_code_seed',
    );
    expect(renderAddUniqueConstraint('matches', ['room_code', 'seed'])).toBe(
      'ALTER TABLE "matches" ADD CONSTRAINT "ion_uq_matches_room_code_seed" UNIQUE ("room_code", "seed")',
    );
  });

  it('groupKey is order-insensitive', () => {
    expect(groupKey(['b', 'a'])).toBe(groupKey(['a', 'b']));
  });
});
