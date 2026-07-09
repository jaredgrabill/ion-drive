/**
 * Ephemeral-server plumbing for `ion-drive block test` (spec-06 §1).
 *
 * The command boots a **real** Ion Drive server the same way a scaffolded
 * project does — `createServer()` + the vendored-blocks barrel — but inside a
 * throwaway temp project and against a per-run scratch database:
 *
 *  - {@link createScratchDb}/{@link dropScratchDb} — `CREATE DATABASE
 *    ion_blocktest_<rand>` on the caller-provided Postgres (the core
 *    integration suite's `ion_it_*` pattern: drain `pg_stat_activity`, then
 *    `DROP … WITH (FORCE)`).
 *  - {@link resolvePackageDir} — locates `@ion-drive/core` / `tsx` / `zod`
 *    **project-first** (a globally-installed CLI picks up the project's own
 *    core), then from the CLI's own tree (the `core-loader.ts` precedent).
 *  - {@link linkDependency} — junction-links (Windows) / symlinks (POSIX) the
 *    resolved packages into the temp project's `node_modules`, so the
 *    generated boot module and the vendored block code resolve them without an
 *    `npm install` in the loop. Node resolves through the link's realpath, so
 *    each package's own dependencies come from its real install location.
 *  - {@link startEphemeralServer} — spawns `node --import tsx server-boot.ts`
 *    (cwd = temp dir), waits for the `ION_BLOCK_TEST_READY {json}` marker on
 *    stdout (60s budget), and hands back the base URL + a run-scoped
 *    admin-role API key minted by the boot module. Child stdio is buffered and
 *    replayed only on failure (or kept for `--keep` debugging).
 *
 * Handlers register at boot (the barrel loads the vendored plugins), so the
 * caller's order is: plan → vendor → boot → install — no handler polling.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

/** Thrown for expected ephemeral-server failures (rendered, never a stack). */
export class EphemeralServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EphemeralServerError';
  }
}

/** The default connection point when neither --database-url nor env is set. */
export const DEFAULT_DATABASE_URL = 'postgresql://ion:ion@localhost:5432/ion_drive';

// ---------------------------------------------------------------------------
// Scratch database (the parent owns it — spec-06 D3)
// ---------------------------------------------------------------------------

/** Creates `ion_blocktest_<6hex>` on the admin DSN; returns its name + URL. */
export async function createScratchDb(adminUrl: string): Promise<{ name: string; url: string }> {
  const name = `ion_blocktest_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (err) {
    throw new EphemeralServerError(
      `block test needs a reachable Postgres at ${adminUrl} (pass --database-url or set ION_DATABASE_URL; start one with \`docker compose up -d\`). Connection failed: ${(err as Error).message}`,
    );
  }
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

/**
 * Drops the scratch database: wait until `pg_stat_activity` shows no sessions
 * (pg-pool's `end()` resolves before its Terminate packets land), then
 * `DROP DATABASE IF EXISTS … WITH (FORCE)` as the belt for true leaks —
 * the core integration suite's exact teardown recipe.
 */
export async function dropScratchDb(adminUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await client.query(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      if (res.rows[0]?.n === 0) break;
      await sleep(250);
    }
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Package resolution + junction linking
// ---------------------------------------------------------------------------

/** The D1 hard-error pointer, styled like core-loader's CORE_REQUIRED_MESSAGE. */
export const BLOCK_TEST_CORE_MESSAGE =
  'Could not load @ion-drive/core — block test boots a real server with its createServer(). ' +
  'Install it (`npm i -g @ion-drive/core`) or run inside an Ion Drive project.';

/** Resolves a package's root directory from one base directory, or null. */
function resolveFrom(baseDir: string, name: string): string | null {
  const req = createRequire(join(baseDir, 'package.json'));
  // Preferred: the package exports ./package.json (core does).
  try {
    return dirname(req.resolve(`${name}/package.json`));
  } catch {
    /* fall through to the entry-point walk-up */
  }
  // Fallback for packages whose exports map hides package.json (tsx does):
  // resolve the entry, then walk up to the directory carrying the manifest.
  try {
    let dir = dirname(req.resolve(name));
    for (let i = 0; i < 10; i++) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
          if (pkg.name === name) return dir;
        } catch {
          /* unreadable manifest — keep walking */
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not resolvable from this base */
  }
  return null;
}

/**
 * Locates an npm package's directory **project-first** (`process.cwd()`), then
 * from the CLI's own tree, then — for packages like `zod` that are core's
 * dependencies rather than the CLI's — from inside any `viaDirs` package
 * roots. Returns null when nowhere resolvable.
 */
export function resolvePackageDir(name: string, viaDirs: string[] = []): string | null {
  const bases = [process.cwd(), dirname(filePathOfThisModule())];
  for (const base of bases) {
    const dir = resolveFrom(base, name);
    if (dir) return dir;
  }
  for (const via of viaDirs) {
    const dir = resolveFrom(via, name);
    if (dir) return dir;
  }
  return null;
}

/** This module's directory as a filesystem path (import.meta.url → path). */
function filePathOfThisModule(): string {
  const url = new URL(import.meta.url);
  let path = decodeURIComponent(url.pathname);
  // Windows file URLs carry a leading slash before the drive letter.
  if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
  return path;
}

/**
 * Links `targetDir` into `<projectDir>/node_modules/<name>` — a **junction**
 * on Windows (no elevation needed; targets must be absolute) and a plain
 * directory symlink on POSIX. Scoped names get their scope directory created.
 */
export function linkDependency(projectDir: string, name: string, targetDir: string): void {
  const linkPath = join(projectDir, 'node_modules', ...name.split('/'));
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath)) return;
  symlinkSync(resolve(targetDir), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

// ---------------------------------------------------------------------------
// The generated boot module
// ---------------------------------------------------------------------------

/**
 * Renders `server-boot.ts` — the temp project's composition root. It mirrors
 * the scaffold's `server.ts` (createServer + the blocks barrel) with three
 * test-harness differences: it listens on **port 0** directly (the config
 * schema rejects port 0, so the OS-assigned port is read back from
 * `server.addresses()`), it mints a user-less **admin-role API key** for the
 * run (ION_REQUIRE_AUTH is on — the suite exercises the authenticated
 * surface), and it prints one `ION_BLOCK_TEST_READY {json}` marker line the
 * parent parses. A `shutdown` line on stdin triggers `handle.close()`.
 */
export function renderBootModule(): string {
  return `/** Generated by \`ion-drive block test\` — the ephemeral test server. */
import { createServer } from '@ion-drive/core';
import { blocks } from './blocks/index.js';

const handle = await createServer(undefined, { plugins: blocks });
await handle.server.listen({ port: 0, host: '127.0.0.1' });
const address = handle.server.addresses()[0];
if (!address) throw new Error('server reported no listening address');

const adminRole = await handle.roleManager.getByName('admin');
if (!adminRole) throw new Error('seeded admin role not found');
const apiKey = await handle.apiKeyManager.create({ name: 'block-test', roleId: adminRole.id });

console.log(\`ION_BLOCK_TEST_READY \${JSON.stringify({ port: address.port, apiKey: apiKey.key })}\`);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('shutdown')) {
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  }
});
`;
}

// ---------------------------------------------------------------------------
// Spawning + lifecycle
// ---------------------------------------------------------------------------

export interface EphemeralServerOptions {
  /** The prepared temp project directory (barrel + vendored code + links). */
  projectDir: string;
  /** Scratch-database connection string for the child's ION_DATABASE_URL. */
  databaseUrl: string;
  /** Marker budget in ms (default 60s). */
  timeoutMs?: number;
}

export interface EphemeralServer {
  url: string;
  apiKey: string;
  /** Graceful stop: `shutdown` over stdin, then a kill-tree fallback. */
  stop(): Promise<void>;
  /** Everything the child printed so far (replayed on failure / --keep). */
  logs(): string;
}

/**
 * The child environment: a scrubbed copy of the parent's env (every `ION_*`
 * removed so the operator's dev settings can't leak into the test run) plus
 * the run's own knobs — scratch DB, auth ON, rate limiting/metrics/admin OFF,
 * quiet logs, per-run secrets.
 */
export function buildChildEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ION_')) env[key] = value;
  }
  env.NODE_ENV = 'test';
  env.ION_DATABASE_URL = databaseUrl;
  env.ION_REQUIRE_AUTH = 'true';
  env.ION_RATE_LIMIT_ENABLED = 'false';
  env.ION_METRICS_ENABLED = 'false';
  env.ION_ADMIN_ENABLED = 'false';
  env.ION_LOG_LEVEL = 'warn';
  env.ION_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  env.ION_AUTH_SECRET = randomBytes(32).toString('hex');
  return env;
}

/**
 * Kills the child's process tree. On Windows the tsx child may have spawned
 * its own children; `taskkill /t` reaps the tree (the `dev.ts` precedent).
 */
function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', shell: true });
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * Spawns the boot module under tsx and waits for the ready marker.
 * @throws {EphemeralServerError} with the buffered child output on failure
 */
export async function startEphemeralServer(opts: EphemeralServerOptions): Promise<EphemeralServer> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  writeFileSync(join(opts.projectDir, 'server-boot.ts'), renderBootModule(), 'utf8');

  const child = spawn(process.execPath, ['--import', 'tsx', 'server-boot.ts'], {
    cwd: opts.projectDir,
    env: buildChildEnv(opts.databaseUrl),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  const logs = () => output;

  const ready = new Promise<{ port: number; apiKey: string }>((resolvePromise, reject) => {
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new EphemeralServerError(message));
    };
    const timer = setTimeout(() => {
      killTree(child);
      fail(
        `The test server did not become ready within ${Math.round(timeoutMs / 1000)}s. Its output:\n${output || '(no output)'}`,
      );
    }, timeoutMs);
    timer.unref();

    let stdoutBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const marker = line.indexOf('ION_BLOCK_TEST_READY ');
        if (marker === -1) continue;
        try {
          const payload = JSON.parse(line.slice(marker + 'ION_BLOCK_TEST_READY '.length)) as {
            port: number;
            apiKey: string;
          };
          settled = true;
          clearTimeout(timer);
          resolvePromise(payload);
        } catch {
          /* malformed marker — keep waiting (the timeout reports the output) */
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(`Could not spawn the test server (node --import tsx): ${err.message}`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(
        `The test server exited (code ${code ?? 'null'}) before becoming ready. Its output:\n${output || '(no output)'}`,
      );
    });
  });

  const { port, apiKey } = await ready;

  const stop = (): Promise<void> =>
    new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      const reaper = setTimeout(() => {
        killTree(child);
      }, 10_000);
      reaper.unref();
      child.once('exit', () => {
        clearTimeout(reaper);
        resolvePromise();
      });
      try {
        child.stdin?.write('shutdown\n');
      } catch {
        killTree(child);
      }
    });

  return { url: `http://127.0.0.1:${port}`, apiKey, stop, logs };
}

/**
 * Removes a directory with retries — on Windows the just-exited child (or a
 * scanner) can hold `EBUSY`/`EPERM` locks for a few hundred ms.
 */
export function removeDirWithRetry(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* best-effort — a stuck temp dir must not fail the run */
  }
}
