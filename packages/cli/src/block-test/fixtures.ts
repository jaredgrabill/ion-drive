/**
 * `test/fixtures.json` — the tiny, optional per-block fixture file `ion-drive
 * block test` reads (spec-06 §1):
 *
 * ```json
 * {
 *   "actions":    { "<action>": { "input": {…}, "expectStatus": 200 } },
 *   "seedChecks": { "<object>": <minimum row count> }
 * }
 * ```
 *
 * `actions.<name>.input` is POSTed to the action instead of `{}`;
 * `expectStatus` makes the reachability check exact. `seedChecks` raises the
 * registry-reality bar for an object beyond "answers 200 with ≥ seeded rows".
 *
 * The parser is hand-rolled (the CLI carries no runtime Zod) and every
 * rejection names the offending key — a broken fixture file must fail the
 * command loudly, never be silently ignored. A *missing* file is the normal
 * case and yields `{}`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Thrown for a fixtures file the schema rejects — names the offending key. */
export class FixturesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixturesError';
  }
}

/** One action's fixture: the input to POST and (optionally) the exact status. */
export interface ActionFixture {
  input?: Record<string, unknown>;
  expectStatus?: number;
}

/** The parsed `test/fixtures.json` shape. Everything is optional. */
export interface BlockTestFixtures {
  actions?: Record<string, ActionFixture>;
  seedChecks?: Record<string, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses raw `fixtures.json` text into {@link BlockTestFixtures}.
 * @throws {FixturesError} naming the first offending key
 */
export function parseFixtures(raw: string): BlockTestFixtures {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FixturesError(`fixtures.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new FixturesError('fixtures.json must be a JSON object');
  }

  const fixtures: BlockTestFixtures = {};
  for (const key of Object.keys(parsed)) {
    if (key !== 'actions' && key !== 'seedChecks') {
      throw new FixturesError(
        `fixtures.json has an unknown top-level key "${key}" (expected "actions" and/or "seedChecks")`,
      );
    }
  }
  if (parsed.actions !== undefined) fixtures.actions = parseActions(parsed.actions);
  if (parsed.seedChecks !== undefined) fixtures.seedChecks = parseSeedChecks(parsed.seedChecks);
  return fixtures;
}

/** Validates the `actions` map — each entry may carry `input` and `expectStatus`. */
function parseActions(value: unknown): Record<string, ActionFixture> {
  if (!isPlainObject(value)) {
    throw new FixturesError('fixtures.json "actions" must be an object keyed by action name');
  }
  const actions: Record<string, ActionFixture> = {};
  for (const [name, raw] of Object.entries(value)) {
    actions[name] = parseActionFixture(name, raw);
  }
  return actions;
}

/** Validates one `actions.<name>` entry. */
function parseActionFixture(name: string, raw: unknown): ActionFixture {
  if (!isPlainObject(raw)) {
    throw new FixturesError(`fixtures.json actions.${name} must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'input' && key !== 'expectStatus') {
      throw new FixturesError(
        `fixtures.json actions.${name} has an unknown key "${key}" (expected "input" and/or "expectStatus")`,
      );
    }
  }
  const fixture: ActionFixture = {};
  if (raw.input !== undefined) {
    if (!isPlainObject(raw.input)) {
      throw new FixturesError(`fixtures.json actions.${name}.input must be a JSON object`);
    }
    fixture.input = raw.input;
  }
  if (raw.expectStatus !== undefined) {
    const status = raw.expectStatus;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new FixturesError(
        `fixtures.json actions.${name}.expectStatus must be an HTTP status code (100–599)`,
      );
    }
    fixture.expectStatus = status;
  }
  return fixture;
}

/** Validates the `seedChecks` map — object name → minimum row count. */
function parseSeedChecks(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) {
    throw new FixturesError(
      'fixtures.json "seedChecks" must be an object keyed by object name with minimum row counts',
    );
  }
  const checks: Record<string, number> = {};
  for (const [object, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw new FixturesError(
        `fixtures.json seedChecks.${object} must be a non-negative integer row count`,
      );
    }
    checks[object] = raw;
  }
  return checks;
}

/**
 * Reads a block directory's `test/fixtures.json`. A missing file is the
 * normal case and yields `{}`; a present-but-invalid file throws
 * {@link FixturesError} (a broken fixture must never be silently ignored).
 */
export function readFixtures(blockDir: string): BlockTestFixtures {
  const path = join(blockDir, 'test', 'fixtures.json');
  if (!existsSync(path)) return {};
  return parseFixtures(readFileSync(path, 'utf8'));
}
