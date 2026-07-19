/**
 * Unit tests for `DataService.aggregate` (issue #13): parameter validation
 * (fn/field rules) and query construction (which aggregate expression and
 * WHERE conditions reach the query builder). Real-SQL behaviour is covered by
 * the integration suite (`integration/aggregate.integration.test.ts`).
 */

import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../db/types.js';
import type { SchemaRegistry } from '../schema/schema-registry.js';
import { DataService, DataServiceError } from './data-service.js';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const FIELDS = [
  { name: 'id', columnName: 'id', isSystem: true, isPrimary: true, columnType: 'uuid' },
  { name: 'name', columnName: 'name', isSystem: false, isPrimary: false, columnType: 'text' },
  { name: 'wins', columnName: 'wins', isSystem: false, isPrimary: false, columnType: 'integer' },
  {
    // API name differs from the physical column, to prove resolution.
    name: 'damage',
    columnName: 'damage_dealt',
    isSystem: false,
    isPrimary: false,
    columnType: 'float',
  },
  { name: 'stars', columnName: 'stars', isSystem: false, isPrimary: false, columnType: 'rating' },
];

const registry = {
  getTableName: (object: string) => (object === 'players' ? 'players' : undefined),
  getFields: () => FIELDS,
  getField: (_object: string, fieldName: string) => FIELDS.find((f) => f.name === fieldName),
} as unknown as SchemaRegistry;

/** What the fake query builder observed for one aggregate call. */
interface Observed {
  table?: string;
  /** `[kind, column]` pairs produced by the select callback's expression builder. */
  selections: [string, string | undefined][];
  /** Arguments of every `.where()` call (filters + search). */
  wheres: unknown[][];
}

/**
 * A Kysely stand-in for the aggregate read path: `selectFrom().select(cb)`
 * followed by chained `.where()` and a final `executeTakeFirst()`. The select
 * callback runs against a fake expression builder whose `fn.*` helpers record
 * which aggregate/column was requested.
 */
function fakeAggregateDb(row: Record<string, unknown> | undefined): {
  db: Kysely<TenantDatabase>;
  observed: Observed;
} {
  const observed: Observed = { selections: [], wheres: [] };

  const record = (kind: string, column?: string) => ({
    as: () => {
      observed.selections.push([kind, column]);
      return { kind, column };
    },
  });
  const eb = {
    fn: {
      countAll: () => record('countAll'),
      count: (col: string) => record('count', col),
      sum: (col: string) => record('sum', col),
      avg: (col: string) => record('avg', col),
      min: (col: string) => record('min', col),
      max: (col: string) => record('max', col),
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: mirrors Kysely's dynamic chaining
  const builder: any = {
    select(cb: (b: typeof eb) => unknown[]) {
      for (const selection of cb(eb)) void selection;
      return builder;
    },
    where(...args: unknown[]) {
      observed.wheres.push(args);
      return builder;
    },
    executeTakeFirst: async () => row,
  };

  const db = {
    selectFrom(table: string) {
      observed.table = table;
      return builder;
    },
  } as unknown as Kysely<TenantDatabase>;

  return { db, observed };
}

function service(row: Record<string, unknown> | undefined = { total: '0' }) {
  const { db, observed } = fakeAggregateDb(row);
  return { service: new DataService(db, registry), observed };
}

async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DataServiceError);
  expect((err as DataServiceError).code).toBe(code);
  expect((err as DataServiceError).statusCode).toBe(400);
}

// ---------------------------------------------------------------------------
// Parameter validation
// ---------------------------------------------------------------------------

describe('DataService.aggregate validation', () => {
  it('rejects an unknown aggregate function', async () => {
    const { service: svc } = service();
    await expectError(svc.aggregate('players', 'median', 'wins'), 'INVALID_AGGREGATE_FUNCTION');
  });

  it('rejects a comma-joined multi-fn request (single fn per call)', async () => {
    const { service: svc } = service();
    await expectError(svc.aggregate('players', 'count,max', 'wins'), 'INVALID_AGGREGATE_FUNCTION');
  });

  it('requires a field for the value functions', async () => {
    const { service: svc } = service();
    await expectError(svc.aggregate('players', 'sum', undefined), 'AGGREGATE_FIELD_REQUIRED');
    await expectError(svc.aggregate('players', 'avg', undefined), 'AGGREGATE_FIELD_REQUIRED');
    await expectError(svc.aggregate('players', 'min', undefined), 'AGGREGATE_FIELD_REQUIRED');
    await expectError(svc.aggregate('players', 'max', undefined), 'AGGREGATE_FIELD_REQUIRED');
  });

  it('rejects a non-numeric field for the value functions', async () => {
    const { service: svc } = service();
    await expectError(svc.aggregate('players', 'avg', 'name'), 'AGGREGATE_FIELD_NOT_NUMERIC');
  });

  it('accepts the rating pseudo-numeric type', async () => {
    const { service: svc } = service({ total: '3', value: '4' });
    const result = await svc.aggregate('players', 'max', 'stars');
    expect(result.value).toBe(4);
  });

  it('rejects an unknown aggregate field', async () => {
    const { service: svc } = service();
    await expectError(svc.aggregate('players', 'sum', 'nope'), 'UNKNOWN_FIELD');
  });

  it('rejects an unknown filter field', async () => {
    const { service: svc } = service();
    await expectError(
      svc.aggregate('players', 'count', undefined, {
        filters: [{ field: 'nope', operator: 'gt', value: 1 }],
      }),
      'UNKNOWN_FIELD',
    );
  });

  it('404s for an unknown object', async () => {
    const { service: svc } = service();
    const err = await svc.aggregate('ghosts', 'count', undefined).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as DataServiceError).code).toBe('OBJECT_NOT_FOUND');
    expect((err as DataServiceError).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Query construction + result shaping
// ---------------------------------------------------------------------------

describe('DataService.aggregate query construction', () => {
  it('builds a bare count from COUNT(*) only', async () => {
    const { service: svc, observed } = service({ total: '42' });
    const result = await svc.aggregate('players', 'count', undefined);

    expect(observed.table).toBe('players');
    expect(observed.selections).toEqual([['countAll', undefined]]);
    expect(result).toEqual({ fn: 'count', field: null, value: 42, filteredCount: 42 });
  });

  it('counts non-null values when count is given a field', async () => {
    const { service: svc, observed } = service({ total: '10', value: '7' });
    const result = await svc.aggregate('players', 'count', 'wins');

    expect(observed.selections).toEqual([
      ['countAll', undefined],
      ['count', 'wins'],
    ]);
    expect(result).toEqual({ fn: 'count', field: 'wins', value: 7, filteredCount: 10 });
  });

  it('aggregates the physical column and applies the filters', async () => {
    const { service: svc, observed } = service({ total: '812', value: '1234.5' });
    const result = await svc.aggregate('players', 'avg', 'damage', {
      filters: [{ field: 'wins', operator: 'gte', value: 10 }],
    });

    // The API field name `damage` resolves to its physical column.
    expect(observed.selections).toEqual([
      ['countAll', undefined],
      ['avg', 'damage_dealt'],
    ]);
    expect(observed.wheres).toEqual([['wins', '>=', 10]]);
    expect(result).toEqual({ fn: 'avg', field: 'damage', value: 1234.5, filteredCount: 812 });
  });

  it('ANDs the free-text search into the same condition pipeline', async () => {
    const { service: svc, observed } = service({ total: '1', value: '9' });
    await svc.aggregate('players', 'max', 'wins', {
      filters: [{ field: 'wins', operator: 'gt', value: 5 }],
      search: 'ada',
    });

    // One where per filter plus one for the search OR-expression callback.
    expect(observed.wheres).toHaveLength(2);
    expect(typeof observed.wheres[1]?.[0]).toBe('function');
  });

  it('returns value null for an empty set (SQL semantics), with filteredCount 0', async () => {
    const { service: svc } = service({ total: '0', value: null });
    const result = await svc.aggregate('players', 'sum', 'wins');
    expect(result).toEqual({ fn: 'sum', field: 'wins', value: null, filteredCount: 0 });
  });
});
