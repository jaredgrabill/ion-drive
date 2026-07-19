/**
 * `ion-drive init [directory]` — scaffolds a user-owned framework project
 * (Phase 14, ADR-018): `server.ts` composition root, `/blocks` barrel, env
 * files with generated secrets, Postgres compose file, the `ion/` client
 * starter, and agent instructions. Never clobbers existing files.
 *
 * `--config-only` keeps the older behavior — just write `ion.config.json`
 * pointing at an existing server (useful when the backend runs elsewhere).
 */

import prompts from 'prompts';
import { IonApiClient } from '../api-client.js';
import {
  type IonProjectConfig,
  configExists,
  configPath,
  readConfig,
  writeConfig,
} from '../config.js';
import { DEFAULT_PG_PORT, detectPgPort, scaffoldProject } from '../project-scaffold.js';
import { reportStarter, writeStarter } from '../scaffold.js';
import { banner, box, c, log, sym } from '../ui.js';
import { warnOnVersionSkew } from '../version-check.js';

export interface InitOptions {
  serverUrl?: string;
  apiKey?: string;
  yes?: boolean;
  /** Scaffold a TypeScript starter using @ion-drive/client (default: yes). */
  starter?: boolean;
  /** Only write ion.config.json (pre-Phase-14 behavior). */
  configOnly?: boolean;
}

export async function initCommand(
  directory: string | undefined,
  options: InitOptions,
): Promise<void> {
  console.log(banner());

  if (options.configOnly) {
    await configOnlyInit(options);
    return;
  }

  const dir = directory ?? '.';
  log.step(
    `Scaffolding an Ion Drive project in ${c.cyan(dir === '.' ? 'the current directory' : dir)}…`,
  );
  log.raw();

  // A busy 5432 (native Postgres, another compose stack) would fail the very
  // first `docker compose up` — probe and scaffold a free host port instead.
  const pgPort = await detectPgPort();

  const result = scaffoldProject(dir, { pgPort });
  for (const path of result.created) log.raw(`  ${sym.check} ${c.cyan(path)}`);
  if (result.skipped.length > 0) {
    log.dim(`  ${sym.dot} kept existing: ${result.skipped.join(', ')}`);
  }
  if (pgPort !== DEFAULT_PG_PORT && result.created.includes('.env')) {
    log.warn(
      `Port ${DEFAULT_PG_PORT} is in use on this machine — the compose Postgres will publish on ${c.cyan(String(pgPort))} instead (ION_PG_PORT in .env; change that one line to move it).`,
    );
  }

  // The CLI's own config: add/remove/list target the local dev server.
  const config: IonProjectConfig = {
    ...readConfig(dir),
    serverUrl: options.serverUrl ?? 'http://localhost:3000',
    apiKey: options.apiKey,
  };
  writeConfig(config, dir);

  // Client starter under ion/ (skip-if-exists, same as everything else).
  if (options.starter !== false) {
    reportStarter(writeStarter(dir).map((p) => p));
  }

  log.raw();
  console.log(
    box('Ready for launch', [
      `${sym.rocket} ${c.bold('Next steps')}`,
      '',
      ...(dir !== '.' ? [`${sym.dot} cd ${dir}`] : []),
      `${sym.dot} docker compose up -d     ${c.meteor('# PostgreSQL')}`,
      `${sym.dot} npm install`,
      `${sym.dot} npm run dev              ${c.meteor('# API :3000 · admin at /admin')}`,
      '',
      `${c.meteor('Sign up at /admin (first user becomes admin), then API Keys ->')}`,
      `${c.meteor('mint a role-bound key so your AI agent can use /api/v1/mcp.')}`,
      '',
      `${c.meteor('Then:')} ${c.star('ion-drive add crm')}  ${c.meteor('to install your first block')}`,
    ]),
  );
}

/** The pre-Phase-14 flow: prompt for a server URL/API key, write ion.config.json. */
async function configOnlyInit(options: InitOptions): Promise<void> {
  if (configExists() && !options.yes) {
    const { overwrite } = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: `${configPath()} already exists. Overwrite?`,
      initial: false,
    });
    if (!overwrite) {
      log.warn('Init cancelled — existing config kept.');
      return;
    }
  }

  const existing = readConfig();
  const answers = options.yes
    ? { serverUrl: options.serverUrl ?? existing.serverUrl, apiKey: options.apiKey }
    : await prompts([
        {
          type: 'text',
          name: 'serverUrl',
          message: 'Ion Drive server URL',
          initial: options.serverUrl ?? existing.serverUrl,
        },
        {
          type: 'password',
          name: 'apiKey',
          message: 'API key (iond_…) — leave blank if auth is disabled',
          initial: options.apiKey ?? existing.apiKey ?? '',
        },
      ]);

  if (!answers.serverUrl) {
    log.error('No server URL provided — aborting.');
    process.exitCode = 1;
    return;
  }

  const config: IonProjectConfig = {
    ...existing,
    serverUrl: String(answers.serverUrl).replace(/\/$/, ''),
    apiKey: answers.apiKey ? String(answers.apiKey) : undefined,
  };

  // Probe connectivity (non-fatal — the server may not be up yet).
  log.raw();
  const client = new IonApiClient(config.serverUrl, config.apiKey);
  try {
    const health = await client.health();
    log.success(
      `Connected to Ion Drive ${c.cyan(`v${health.version}`)} ${c.meteor(`(${health.objectCount} objects)`)}`,
    );
    warnOnVersionSkew(health.version);
  } catch {
    log.warn(
      `Could not reach ${config.serverUrl} yet — saved anyway. Start it with "ion-drive dev".`,
    );
  }

  writeConfig(config);
  log.success(`Wrote ${c.cyan('ion.config.json')}`);
}
