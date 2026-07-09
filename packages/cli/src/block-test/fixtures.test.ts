/**
 * Unit tests for the `test/fixtures.json` parser (spec-06): the tiny schema
 * parses, every rejection names the offending key, and a missing file is `{}`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixturesError, parseFixtures, readFixtures } from './fixtures.js';

describe('parseFixtures', () => {
  it('parses the full documented shape', () => {
    expect(
      parseFixtures(
        JSON.stringify({
          actions: { ping: { input: { a: 1 }, expectStatus: 200 }, bare: {} },
          seedChecks: { items: 3 },
        }),
      ),
    ).toEqual({
      actions: { ping: { input: { a: 1 }, expectStatus: 200 }, bare: {} },
      seedChecks: { items: 3 },
    });
  });

  it('parses an empty object', () => {
    expect(parseFixtures('{}')).toEqual({});
  });

  it.each([
    ['not json at all', 'not valid JSON'],
    ['[]', 'must be a JSON object'],
    ['{"unknown": 1}', 'unknown top-level key "unknown"'],
    ['{"actions": []}', '"actions" must be an object'],
    ['{"actions": {"ping": 1}}', 'actions.ping must be an object'],
    ['{"actions": {"ping": {"nope": 1}}}', 'actions.ping has an unknown key "nope"'],
    ['{"actions": {"ping": {"input": []}}}', 'actions.ping.input must be a JSON object'],
    ['{"actions": {"ping": {"expectStatus": 99}}}', 'actions.ping.expectStatus'],
    ['{"seedChecks": {"items": -1}}', 'seedChecks.items must be a non-negative integer'],
    ['{"seedChecks": {"items": "2"}}', 'seedChecks.items must be a non-negative integer'],
  ])('rejects %s with a named error', (raw, message) => {
    expect(() => parseFixtures(raw)).toThrowError(FixturesError);
    expect(() => parseFixtures(raw)).toThrowError(new RegExp(escapeRegExp(message)));
  });
});

describe('readFixtures', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ion-fixtures-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} for a missing file (the normal case)', () => {
    expect(readFixtures(dir)).toEqual({});
  });

  it('throws for a present-but-broken file — never silently ignored', () => {
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test', 'fixtures.json'), '{"actions": []}', 'utf8');
    expect(() => readFixtures(dir)).toThrowError(FixturesError);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
