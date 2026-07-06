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

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isProjectDir } from '../project.js';
import { banner, c, log, sym } from '../ui.js';

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

  const child = spawn('pnpm', ['--filter', '@ionshift/ion-drive-core', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env,
  });
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
