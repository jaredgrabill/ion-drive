/**
 * `ion-drive dev` — launches the Ion Drive development server.
 *
 * In this monorepo the server lives in `@ionshift/ion-drive-core`, so `dev` spawns its
 * watch script and streams the output beneath the banner. It's a convenience
 * wrapper: the authoritative way to run the server is still core's own `dev`.
 */

import { spawn } from 'node:child_process';
import { readConfig } from '../config.js';
import { banner, c, log, sym } from '../ui.js';

export interface DevOptions {
  port?: string;
}

export async function devCommand(options: DevOptions): Promise<void> {
  console.log(banner());
  const config = readConfig();

  log.step(`Igniting the core engine ${sym.rocket}`);
  log.dim(`  target ${config.serverUrl}${options.port ? ` · port ${options.port}` : ''}`);
  log.raw();

  const env = { ...process.env };
  if (options.port) env.ION_PORT = options.port;

  // Prefer pnpm (workspace-aware); fall back to npm. shell:true for Windows.
  const child = spawn('pnpm', ['--filter', '@ionshift/ion-drive-core', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env,
  });

  child.on('error', (err) => {
    log.error(`Could not start the dev server: ${err.message}`);
    log.dim(`  Try running it directly:  ${c.star('pnpm --filter @ionshift/ion-drive-core dev')}`);
    process.exitCode = 1;
  });

  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
}
