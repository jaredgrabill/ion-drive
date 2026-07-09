/**
 * Integration suite for `ion-drive block test` (spec-06 AC1–AC4, CLI side).
 *
 * Shells the real CLI (`node --import tsx src/index.ts block test …`) against
 * a reachable Postgres — every ephemeral run creates its own scratch database
 * (`ion_blocktest_*`) and boots a real Ion Drive server, so this suite needs
 * the same environment as core's: `ION_DATABASE_URL` (default
 * `postgresql://ion:ion@localhost:5432/ion_drive`) and a built
 * `@ion-drive/core` (its `dist/` is what the ephemeral server imports).
 *
 * Covered:
 *  - the green path: fixture block + `--deps-from` local dependency, all
 *    checks pass, `--json` shape (AC1's command loop);
 *  - AC2: a broken block (action declared, handler never registered) fails
 *    with the installer's actionable error; an orphan table inside the block
 *    footprint fails the doctor assertion (exercised against a real doctor
 *    report from a live server);
 *  - AC3: `--server` refuses an instance with user objects without `--force`,
 *    and passes with zero residue on a fresh one;
 *  - AC4: a failing block-local `test/*.test.ts` fails the command.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DoctorReportWire } from '../api-client.js';
import { evaluateDoctorReport } from './assertions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..', '..');
const FIXTURES = join(HERE, '__fixtures__');
const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';

/** Isolated registry cache so the suite never touches ~/.ion-drive. */
const cacheDir = mkdtempSync(join(tmpdir(), 'ion-blocktest-cache-'));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI from source (`node --import tsx src/index.ts …`). */
function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: CLI_ROOT,
      env: {
        ...process.env,
        ION_DATABASE_URL: ADMIN_URL,
        ION_DRIVE_CACHE_DIR: cacheDir,
        NO_COLOR: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

interface JsonReport {
  block: string;
  version: string;
  mode: string;
  ok: boolean;
  checks: { name: string; status: string; detail?: string }[];
  error?: string;
}

function parseJson(result: CliResult): JsonReport {
  try {
    return JSON.parse(result.stdout) as JsonReport;
  } catch {
    throw new Error(
      `CLI did not print JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function checkByName(report: JsonReport, name: string) {
  const check = report.checks.find((c) => c.name === name);
  if (!check) throw new Error(`no check named "${name}" in ${JSON.stringify(report.checks)}`);
  return check;
}

// ---------------------------------------------------------------------------
// Ephemeral mode
// ---------------------------------------------------------------------------

describe('block test — ephemeral mode', () => {
  it('runs the fixture block green end-to-end with a --deps-from dependency', async () => {
    const result = await runCli([
      'block',
      'test',
      join(FIXTURES, 'block-testable'),
      '--deps-from',
      FIXTURES,
      '--json',
    ]);
    const report = parseJson(result);
    expect(result.code, result.stderr).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe('ephemeral');
    expect(checkByName(report, 'manifest parses').status).toBe('pass');
    expect(checkByName(report, 'dependencies').status).toBe('pass');
    expect(checkByName(report, 'dependencies').detail).toContain('plain@0.1.0');
    expect(checkByName(report, 'install report clean').status).toBe('pass');
    expect(checkByName(report, 'objects reachable').status).toBe('pass');
    expect(checkByName(report, 'actions reachable').status).toBe('pass');
    expect(checkByName(report, 'block-local tests').status).toBe('pass');
    expect(checkByName(report, 'uninstall leaves no residue').status).toBe('pass');
  });

  it('fails a broken block (declared action, no handler) with the actionable install error', async () => {
    const result = await runCli(['block', 'test', join(FIXTURES, 'block-broken'), '--json']);
    const report = parseJson(result);
    expect(result.code).toBe(1);
    expect(report.ok).toBe(false);
    const install = checkByName(report, 'install report clean');
    expect(install.status).toBe('fail');
    // The installer's actionable pointer: vendor the code into /blocks/<name>.
    expect(install.detail).toMatch(/blocks\/broken|not registered|vendor/i);
  });

  it('fails when a block-local test fails (AC4)', async () => {
    const blockDir = mkdtempSync(join(tmpdir(), 'ion-failing-block-'));
    try {
      writeFileSync(
        join(blockDir, 'block.json'),
        `${JSON.stringify(
          {
            name: 'failer',
            version: '0.1.0',
            title: 'Failer',
            description: 'Fixture whose own tests fail.',
            objects: [
              {
                name: 'failer_items',
                displayName: 'Failer Items',
                fields: [
                  { name: 'label', displayName: 'Label', columnType: 'text', isRequired: true },
                ],
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      mkdirSync(join(blockDir, 'test'));
      writeFileSync(
        join(blockDir, 'test', 'always-fails.test.ts'),
        [
          "import assert from 'node:assert/strict';",
          "import { test } from 'node:test';",
          "test('deliberately fails', () => { assert.equal(1, 2); });",
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await runCli(['block', 'test', blockDir, '--json']);
      const report = parseJson(result);
      expect(result.code).toBe(1);
      expect(checkByName(report, 'block-local tests').status).toBe('fail');
      // The uninstall still ran (finally-guarded) and passed.
      expect(checkByName(report, 'uninstall leaves no residue').status).toBe('pass');
    } finally {
      rmSync(blockDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// --server mode (AC3) + the orphan-doctor teeth (AC2 second half)
// ---------------------------------------------------------------------------

describe('block test — --server mode', () => {
  const scratchDb = `ion_it_clitest_${randomBytes(4).toString('hex')}`;
  let adminClient: pg.Client;
  // biome-ignore lint/suspicious/noExplicitAny: the core handle type lives in core; the suite only uses server/close
  let app: any;
  let serverUrl = '';

  function scratchUrl(): string {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${scratchDb}`;
    return url.toString();
  }

  beforeAll(async () => {
    adminClient = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5000 });
    try {
      await adminClient.connect();
    } catch (err) {
      throw new Error(
        `Integration suite requires a reachable Postgres at ${ADMIN_URL} (set ION_DATABASE_URL). Connection failed: ${(err as Error).message}`,
      );
    }
    await adminClient.query(`CREATE DATABASE ${scratchDb}`);

    const { createServer } = await import('@ion-drive/core');
    app = await createServer({
      databaseUrl: scratchUrl(),
      rateLimitEnabled: false,
      metricsEnabled: false,
      otelEnabled: false,
      nodeEnv: 'test',
      logLevel: 'fatal',
    });
    await app.server.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.addresses()[0] as { port: number };
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
    // Drain then FORCE-drop — the core suite's teardown recipe.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await adminClient.query(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
        [scratchDb],
      );
      if (res.rows[0]?.n === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await adminClient.query(`DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`);
    await adminClient.end();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('refuses a server with user objects without --force, then passes clean with zero residue', async () => {
    // Give the server a user object → refusal.
    const created = await fetch(`${serverUrl}/api/v1/schema/objects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'residents',
        displayName: 'Residents',
        fields: [{ name: 'label', displayName: 'Label', columnType: 'text' }],
      }),
    });
    expect(created.status).toBe(201);

    const refused = await runCli([
      'block',
      'test',
      join(FIXTURES, 'plain'),
      '--server',
      serverUrl,
      '--json',
    ]);
    expect(refused.code).toBe(1);
    expect(parseJson(refused).error).toMatch(/Refusing to test against/);

    // Remove the object → the same run passes and leaves zero residue.
    const dropped = await fetch(`${serverUrl}/api/v1/schema/objects/residents`, {
      method: 'DELETE',
    });
    expect(dropped.status).toBeLessThan(300);

    const passed = await runCli([
      'block',
      'test',
      join(FIXTURES, 'plain'),
      '--server',
      serverUrl,
      '--json',
    ]);
    const report = parseJson(passed);
    expect(passed.code, passed.stderr).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe('server');

    // Zero residue: no ledger entry, no data endpoint, no schema object.
    const blocks = (await (await fetch(`${serverUrl}/api/v1/blocks`)).json()) as {
      data: { name: string }[];
    };
    expect(blocks.data.some((b) => b.name === 'plain')).toBe(false);
    expect((await fetch(`${serverUrl}/api/v1/data/plain_notes`)).status).toBe(404);
  });

  it('doctor assertion has teeth: a recreated footprint table fails it (AC2)', async () => {
    // Simulate an uninstall that left an orphan: create the table by hand.
    const scratch = new pg.Client({ connectionString: scratchUrl() });
    await scratch.connect();
    try {
      await scratch.query('CREATE TABLE plain_notes (id integer)');
      const doctor = (await (await fetch(`${serverUrl}/api/v1/schema/doctor`)).json()) as {
        data: DoctorReportWire;
      };
      const verdict = evaluateDoctorReport(new Set(['plain_notes']), doctor.data);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems[0]).toMatch(/unmanaged_table "plain_notes"/);
    } finally {
      await scratch.query('DROP TABLE IF EXISTS plain_notes');
      await scratch.end();
    }
  });
});
