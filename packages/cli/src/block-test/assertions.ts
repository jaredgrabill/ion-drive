/**
 * The built-in assertion suite for `ion-drive block test` (spec-06 §1 step 6).
 *
 * Six checks, each yielding a {@link CheckResult}:
 *
 *  1. **manifest** — the block parses (core's strict Zod when resolvable,
 *     always the CLI's structural checks).
 *  2. **install report** — everything the manifest declares was created or
 *     *explainably* skipped ({@link evaluateInstallReport}, pure: skipped
 *     items must appear in the created/skipped lists or be named by a report
 *     warning; report warnings surface as notices, not failures).
 *  3. **registry reality** — every declared object answers
 *     `GET /api/v1/data/<object>` with 200 and at least its seeded row count
 *     (raised further by `fixtures.seedChecks`).
 *  4. **actions reachable** — every declared action answers its
 *     `POST /api/v1/blocks/<block>/actions/<action>`: 2xx passes; a 400 passes
 *     only for the no-fixture `{}` probe (the action's own Zod rejecting a
 *     blank input proves "wired and reachable"); a fixture with
 *     `expectStatus` demands that exact status; 404 ("not wired") and 5xx
 *     ("handler blew up") fail with the server's message.
 *  5. **uninstall** — `DELETE ?dropData=true` succeeds, the block vanishes
 *     from the ledger, and the schema doctor reports no orphan
 *     (`unmanaged_table`/`missing_table`) finding inside the block's
 *     footprint ({@link evaluateDoctorReport}, pure).
 *  6. **block-local tests** — when the block ships `test/`, they run under
 *     `tsx --test` with the `ION_TEST_SERVER_URL`/`ION_TEST_API_KEY` env
 *     contract; a non-zero exit fails the command.
 *
 * The pure evaluators are exported for unit tests; the `check*` wrappers do
 * the IO against a live server through {@link IonApiClient}.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApiError,
  type DoctorReportWire,
  type InstallReport,
  type IonApiClient,
} from '../api-client.js';
import type { Manifest } from '../registry/registry-client.js';
import type { BlockTestFixtures } from './fixtures.js';

/** One assertion's outcome — the unit the checklist and `--json` render. */
export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

// ---------------------------------------------------------------------------
// Manifest declaration helpers
// ---------------------------------------------------------------------------

/** The `name` fields of one manifest array (objects, actions, roles, …). */
export function declaredNames(manifest: Manifest, key: string): string[] {
  const list = manifest[key];
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (entry as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string');
}

/** Seeded row counts per object, straight from the manifest's `seed` map. */
export function declaredSeedCounts(manifest: Manifest): Record<string, number> {
  const seed = manifest.seed;
  if (typeof seed !== 'object' || seed === null || Array.isArray(seed)) return {};
  const counts: Record<string, number> = {};
  for (const [object, rows] of Object.entries(seed as Record<string, unknown>)) {
    if (Array.isArray(rows)) counts[object] = rows.length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Check 2 — install report (pure)
// ---------------------------------------------------------------------------

export interface InstallReportEvaluation {
  ok: boolean;
  problems: string[];
  /** Report warnings — surfaced to the user, never failures. */
  notices: string[];
}

/** True when `name` is covered by a created/skipped list or named by a warning. */
function covered(name: string, lists: (string[] | undefined)[], warnings: string[]): boolean {
  if (lists.some((list) => list?.includes(name))) return true;
  return warnings.some((w) => w.includes(`"${name}"`));
}

/**
 * Pure: does the install report account for everything the manifest declares?
 * Every declared object/relationship/task/role/action/hook/webhook must be
 * created or explainably skipped; subscriptions are compared by count (their
 * report identifiers are server-formatted `consumer ← event` strings).
 */
export function evaluateInstallReport(
  manifest: Manifest,
  report: InstallReport,
): InstallReportEvaluation {
  const problems: string[] = [];
  const warnings = report.warnings ?? [];

  const expectCovered = (kind: string, names: string[], lists: (string[] | undefined)[]) => {
    for (const name of names) {
      if (!covered(name, lists, warnings)) {
        problems.push(`${kind} "${name}" is declared but neither created nor explainably skipped`);
      }
    }
  };

  expectCovered('object', declaredNames(manifest, 'objects'), [
    report.objectsCreated,
    report.objectsSkipped,
  ]);
  expectCovered('relationship', declaredNames(manifest, 'relationships'), [
    report.relationshipsCreated,
  ]);
  expectCovered('task', declaredNames(manifest, 'tasks'), [report.tasksCreated]);
  expectCovered('role', declaredNames(manifest, 'roles'), [
    report.rolesCreated,
    report.rolesSkipped,
  ]);
  expectCovered('action', declaredNames(manifest, 'actions'), [report.actionsExposed]);
  expectCovered('hook', declaredNames(manifest, 'hooks'), [report.hooksExposed]);
  expectCovered('webhook', declaredNames(manifest, 'webhooks'), [
    Object.keys(report.webhooksCreated ?? {}),
    report.webhooksSkipped,
  ]);

  const declaredSubs = Array.isArray(manifest.subscriptions) ? manifest.subscriptions.length : 0;
  const registeredSubs = report.subscriptionsRegistered?.length ?? 0;
  if (declaredSubs > 0 && registeredSubs < declaredSubs) {
    problems.push(
      `manifest declares ${declaredSubs} subscription(s) but the report registered ${registeredSubs}`,
    );
  }

  return { ok: problems.length === 0, problems, notices: warnings };
}

// ---------------------------------------------------------------------------
// Check 3 — registry reality
// ---------------------------------------------------------------------------

/** Every declared object answers its list endpoint with ≥ the expected rows. */
export async function checkObjects(
  client: IonApiClient,
  manifest: Manifest,
  fixtures: BlockTestFixtures,
): Promise<CheckResult> {
  const objects = declaredNames(manifest, 'objects');
  if (objects.length === 0)
    return { name: 'objects reachable', status: 'skip', detail: 'no objects declared' };

  const seedCounts = declaredSeedCounts(manifest);
  const problems: string[] = [];
  let totalRows = 0;
  for (const object of objects) {
    let listed: { totalCount: number };
    try {
      listed = await client.listData(object);
    } catch (err) {
      problems.push(`GET /api/v1/data/${object} failed: ${(err as Error).message}`);
      continue;
    }
    totalRows += listed.totalCount;
    const minimum = Math.max(seedCounts[object] ?? 0, fixtures.seedChecks?.[object] ?? 0);
    if (listed.totalCount < minimum) {
      problems.push(`${object} has ${listed.totalCount} row(s), expected at least ${minimum}`);
    }
  }
  if (problems.length > 0) {
    return { name: 'objects reachable', status: 'fail', detail: problems.join('; ') };
  }
  return {
    name: 'objects reachable',
    status: 'pass',
    detail: `${objects.length} object(s), ${totalRows} row(s)`,
  };
}

// ---------------------------------------------------------------------------
// Check 4 — actions reachable
// ---------------------------------------------------------------------------

/**
 * Pure classification of one action invocation (spec-06 rules): the check
 * asserts "wired and reachable", never business correctness.
 */
export function classifyActionResponse(
  action: string,
  hadFixture: boolean,
  expectStatus: number | undefined,
  status: number,
  message: string | undefined,
): { ok: boolean; detail?: string } {
  if (expectStatus !== undefined) {
    return status === expectStatus
      ? { ok: true }
      : {
          ok: false,
          detail: `${action}: expected ${expectStatus}, got ${status}${message ? ` (${message})` : ''}`,
        };
  }
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400 && !hadFixture) return { ok: true }; // its own Zod rejected `{}` — wired
  if (status === 404) {
    return { ok: false, detail: `${action}: 404${message ? ` — ${message}` : ' — not wired'}` };
  }
  return { ok: false, detail: `${action}: ${status}${message ? ` — ${message}` : ''}` };
}

/** Invokes every declared action with its fixture input (or `{}`). */
export async function checkActions(
  client: IonApiClient,
  manifest: Manifest,
  fixtures: BlockTestFixtures,
): Promise<CheckResult> {
  const actions = declaredNames(manifest, 'actions');
  if (actions.length === 0) {
    return { name: 'actions reachable', status: 'skip', detail: 'no actions declared' };
  }
  const block = String(manifest.name);
  const problems: string[] = [];
  for (const action of actions) {
    const fixture = fixtures.actions?.[action];
    const input = fixture?.input ?? {};
    let response: { status: number; message?: string };
    try {
      response = await client.invokeAction(block, action, input);
    } catch (err) {
      problems.push(`${action}: ${(err as Error).message}`);
      continue;
    }
    const verdict = classifyActionResponse(
      action,
      fixture?.input !== undefined,
      fixture?.expectStatus,
      response.status,
      response.message,
    );
    if (!verdict.ok && verdict.detail) problems.push(verdict.detail);
  }
  if (problems.length > 0) {
    return { name: 'actions reachable', status: 'fail', detail: problems.join('; ') };
  }
  return {
    name: 'actions reachable',
    status: 'pass',
    detail: `${actions.length}/${actions.length}`,
  };
}

// ---------------------------------------------------------------------------
// Check 5 — uninstall + doctor (pure evaluator exported for tests)
// ---------------------------------------------------------------------------

/**
 * The block's table footprint: the ledger's `createdObjects` (object name =
 * table name) plus the junction tables of any declared many-to-many
 * relationships (named `<source>_<target>` by the schema engine).
 */
export function blockFootprint(manifest: Manifest, createdObjects: string[]): Set<string> {
  const footprint = new Set(createdObjects);
  const relationships = Array.isArray(manifest.relationships) ? manifest.relationships : [];
  for (const rel of relationships as {
    type?: string;
    sourceObjectName?: string;
    targetObjectName?: string;
  }[]) {
    if (rel.type === 'many_to_many' && rel.sourceObjectName && rel.targetObjectName) {
      footprint.add(`${rel.sourceObjectName}_${rel.targetObjectName}`);
    }
  }
  return footprint;
}

/**
 * Pure: does the doctor report contain an orphan-table finding inside the
 * block's footprint? (An `unmanaged_table` means dropData left a table behind;
 * a `missing_table` means metadata survived the uninstall.)
 */
export function evaluateDoctorReport(
  footprint: Set<string>,
  report: DoctorReportWire,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const finding of report.findings) {
    if (finding.kind !== 'unmanaged_table' && finding.kind !== 'missing_table') continue;
    if (footprint.has(finding.table)) {
      problems.push(`doctor: ${finding.kind} "${finding.table}" — ${finding.detail}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Uninstalls the block (dropData) and asserts zero residue via the doctor. */
export async function checkUninstall(
  client: IonApiClient,
  manifest: Manifest,
): Promise<CheckResult> {
  const name = String(manifest.name);

  let createdObjects: string[] = [];
  try {
    createdObjects = (await client.getBlock(name)).createdObjects ?? [];
  } catch {
    /* ledger row unreadable — the footprint falls back to declared objects */
    createdObjects = declaredNames(manifest, 'objects');
  }
  const footprint = blockFootprint(manifest, createdObjects);

  try {
    await client.uninstall(name, { dropData: true });
  } catch (err) {
    return {
      name: 'uninstall leaves no residue',
      status: 'fail',
      detail: `uninstall failed: ${(err as Error).message}`,
    };
  }

  const problems: string[] = [];
  try {
    const doctor = await client.doctor();
    problems.push(...evaluateDoctorReport(footprint, doctor).problems);
  } catch (err) {
    problems.push(`doctor check failed: ${(err as Error).message}`);
  }
  try {
    const installed = await client.listInstalled();
    if (installed.some((b) => b.name === name && b.status === 'installed')) {
      problems.push(`"${name}" is still listed as installed after uninstall`);
    }
  } catch (err) {
    problems.push(`ledger re-check failed: ${(err as Error).message}`);
  }

  if (problems.length > 0) {
    return { name: 'uninstall leaves no residue', status: 'fail', detail: problems.join('; ') };
  }
  return { name: 'uninstall leaves no residue', status: 'pass' };
}

// ---------------------------------------------------------------------------
// Check 6 — block-local tests (tsx --test with the env contract)
// ---------------------------------------------------------------------------

/**
 * Runs the block's own `test/` files with `tsx --test` (node's test runner
 * with TypeScript support; zero framework lock-in). The server URL + run API
 * key ride the documented env contract. Output streams straight through.
 */
export async function runBlockLocalTests(
  blockDir: string,
  tsxCliJs: string,
  env: { serverUrl: string; apiKey: string },
  stream: 'inherit' | 'stderr' = 'inherit',
): Promise<CheckResult> {
  if (!existsSync(join(blockDir, 'test'))) {
    return { name: 'block-local tests', status: 'skip', detail: 'no test/ directory' };
  }
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    // A glob (node's own --test globbing, no shell) — a bare `test/` directory
    // argument is treated as a module path and fails to load.
    const child = spawn(process.execPath, [tsxCliJs, '--test', 'test/**/*.test.ts'], {
      cwd: blockDir,
      // Under --json the parent's stdout is the report — route everything to stderr.
      stdio: stream === 'inherit' ? 'inherit' : ['ignore', process.stderr, process.stderr],
      env: {
        ...process.env,
        ION_TEST_SERVER_URL: env.serverUrl,
        ION_TEST_API_KEY: env.apiKey,
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise(code ?? 1));
  }).catch((err: Error) => {
    throw new ApiError(`Could not run block-local tests: ${err.message}`, 0);
  });

  if (exitCode !== 0) {
    return {
      name: 'block-local tests',
      status: 'fail',
      detail: `tsx --test exited with code ${exitCode}`,
    };
  }
  return { name: 'block-local tests', status: 'pass', detail: 'test/' };
}
