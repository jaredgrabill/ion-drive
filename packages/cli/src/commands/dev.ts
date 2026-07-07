/**
 * `ion-drive dev` — runs the development server.
 *
 * Two modes (Phase 14, ADR-018):
 *  - **Framework project** (a scaffolded repo: `server.ts` + core dependency):
 *    ensure the compose Postgres is up (best-effort), then `tsx watch
 *    server.ts`. Editing vendored block code or the composition root
 *    hot-reloads — this loop *is* the product experience.
 *  - **Monorepo contributor**: fall back to spawning core's own watch script
 *    via pnpm, the pre-Phase-14 behavior.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isProjectDir } from '../project.js';
import { banner, c, log, sym } from '../ui.js';

/** How long a Ctrl+C'd dev server gets to shut down before the tree is reaped. */
const KILL_GRACE_MS = 15_000;

/**
 * Kills the spawned dev-server tree. With `shell: true` on Windows the direct
 * child is a cmd.exe wrapper, so a plain `kill()` would orphan the node
 * process that actually holds the port — `taskkill /t` takes down the tree.
 */
function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', shell: true });
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * Makes Ctrl+C reliable: the console already delivers the interrupt to the
 * whole tree, so the first signal just arms a reaper in case the server
 * wedges mid-shutdown; a second signal (impatient user) reaps immediately.
 */
function relaySignals(child: ChildProcess): void {
  let signalsSeen = 0;
  const onSignal = () => {
    signalsSeen += 1;
    if (signalsSeen === 1) {
      setTimeout(() => killTree(child), KILL_GRACE_MS).unref();
    } else {
      killTree(child);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

export interface DevOptions {
  port?: string;
}

export async function devCommand(options: DevOptions): Promise<void> {
  console.log(banner());

  const env = { ...process.env };
  if (options.port) env.ION_PORT = options.port;

  if (isProjectDir()) {
    await runProjectDev(env, options);
  } else {
    runMonorepoDev(env);
  }
}

/** The framework-project loop: compose Postgres up (best-effort), then tsx watch. */
async function runProjectDev(env: NodeJS.ProcessEnv, options: DevOptions): Promise<void> {
  log.step(`Igniting your project ${sym.rocket}`);

  if (existsSync(join(process.cwd(), 'docker-compose.yml'))) {
    await ensurePostgres();
  }

  log.dim(
    `  tsx watch server.ts ${options.port ? `· port ${options.port}` : ''} — edits to server.ts and blocks/ hot-reload`,
  );
  log.raw();

  // npx resolves the project's local tsx install (a scaffold dependency).
  const child = spawn('npx', ['tsx', 'watch', 'server.ts'], {
    stdio: 'inherit',
    shell: true,
    env,
  });
  relaySignals(child);
  child.on('error', (err) => {
    log.error(`Could not start tsx: ${err.message}`);
    log.dim(`  Is tsx installed? Try: ${c.star('npm install')} then ${c.star('npm run dev')}`);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
}

/** Brings up the compose Postgres; failures are informational, never fatal. */
function ensurePostgres(): Promise<void> {
  return new Promise((resolvePromise) => {
    log.dim(`  ${sym.dot} docker compose up -d (PostgreSQL)`);
    const compose = spawn('docker', ['compose', 'up', '-d'], { stdio: 'ignore', shell: true });
    compose.on('error', () => {
      log.warn('Docker not available — make sure PostgreSQL is running (see docker-compose.yml).');
      resolvePromise();
    });
    compose.on('exit', (code) => {
      if (code && code !== 0) {
        log.warn(
          'docker compose failed — make sure PostgreSQL is running (see docker-compose.yml).',
        );
      }
      resolvePromise();
    });
  });
}

/** The monorepo contributor path: spawn core's watch script via pnpm. */
function runMonorepoDev(env: NodeJS.ProcessEnv): void {
  log.step(`Igniting the core engine ${sym.rocket}`);
  log.raw();

  const child = spawn('pnpm', ['--filter', '@ion-drive/core', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env,
  });
  relaySignals(child);
  child.on('error', (err) => {
    log.error(`Could not start the dev server: ${err.message}`);
    log.dim(
      `  Not in an ion-drive project or the monorepo? Scaffold one:  ${c.star('ion-drive init my-app')}`,
    );
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
}
