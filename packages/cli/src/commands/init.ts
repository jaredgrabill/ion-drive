/**
 * `ion-drive init` — scaffolds a project's `ion.config.json`.
 *
 * Prompts for the target server URL and an optional API key, verifies
 * connectivity, and writes the config the other commands read. Idempotent-ish:
 * re-running offers to overwrite an existing config.
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
import { reportStarter, writeStarter } from '../scaffold.js';
import { banner, box, c, log, sym } from '../ui.js';

export interface InitOptions {
  serverUrl?: string;
  apiKey?: string;
  yes?: boolean;
  /** Scaffold a TypeScript starter using @ionshift/ion-drive-client (default: prompt). */
  starter?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  console.log(banner());

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
    serverUrl: String(answers.serverUrl).replace(/\/$/, ''),
    apiKey: answers.apiKey ? String(answers.apiKey) : undefined,
    blocks: existing.blocks,
  };

  // Probe connectivity (non-fatal — the server may not be up yet).
  log.raw();
  const client = new IonApiClient(config.serverUrl, config.apiKey);
  try {
    const health = await client.health();
    log.success(
      `Connected to Ion Drive ${c.cyan(`v${health.version}`)} ${c.meteor(`(${health.objectCount} objects)`)}`,
    );
  } catch {
    log.warn(
      `Could not reach ${config.serverUrl} yet — saved anyway. Start it with "ion-drive dev".`,
    );
  }

  writeConfig(config);

  const wantStarter = await maybeScaffoldStarter(options);

  log.raw();
  console.log(
    box('Ready for launch', [
      `${sym.check} Wrote ${c.cyan('ion.config.json')}`,
      `${sym.planet} Server  ${c.bold(config.serverUrl)}`,
      `${sym.satellite} Auth    ${config.apiKey ? c.success('API key set') : c.meteor('none')}`,
      `${sym.star} Starter ${wantStarter ? c.success('ion/') : c.meteor('skipped')}`,
      '',
      `${c.meteor('Next:')} ${c.star('ion-drive list')}  then  ${c.star('ion-drive add crm')}`,
    ]),
  );
}

/**
 * Scaffolds the client starter when requested. Honours the explicit
 * `--starter`/`--skip-starter` flags; otherwise prompts (unless `--yes`).
 * Returns whether the starter was written.
 */
async function maybeScaffoldStarter(options: InitOptions): Promise<boolean> {
  let wantStarter = options.starter;
  if (wantStarter === undefined && !options.yes) {
    const answer = await prompts({
      type: 'confirm',
      name: 'starter',
      message: 'Scaffold a TypeScript starter using @ionshift/ion-drive-client?',
      initial: true,
    });
    wantStarter = answer.starter !== false;
  }
  if (!wantStarter) return false;

  log.raw();
  log.step('Scaffolding client starter…');
  reportStarter(writeStarter());
  return true;
}
