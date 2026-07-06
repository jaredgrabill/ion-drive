/**
 * `ion-drive remove <block>` — uninstalls a block from the configured server.
 *
 * The server refuses to remove a block that others depend on, or one whose
 * objects still hold rows (unless `--drop-data`). Those guards surface here as
 * clear errors rather than silent data loss.
 */

import ora from 'ora';
import prompts from 'prompts';
import { ApiError, IonApiClient } from '../api-client.js';
import { readConfig, recordRemoved, writeConfig } from '../config.js';
import { hasVendoredCode, removeFromBarrel } from '../project.js';
import { c, log, orbitSpinner, sym } from '../ui.js';
import { warnOnVersionSkew } from '../version-check.js';

export interface RemoveOptions {
  yes?: boolean;
  dropData?: boolean;
}

export async function removeCommand(name: string, options: RemoveOptions): Promise<void> {
  const config = readConfig();
  const client = new IonApiClient(config.serverUrl, config.apiKey);

  try {
    const health = await client.health();
    warnOnVersionSkew(health.version);
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  if (options.dropData) {
    log.warn(
      `--drop-data will permanently DROP the tables created by "${name}" and all their rows.`,
    );
  }

  if (!options.yes) {
    const { go } = await prompts({
      type: 'confirm',
      name: 'go',
      message: `Remove block "${name}"${options.dropData ? ' and drop its data' : ''}?`,
      initial: false,
    });
    if (!go) {
      log.warn('Aborted.');
      return;
    }
  }

  const spinner = ora({ text: `Removing ${c.bold(name)}…`, spinner: orbitSpinner }).start();
  try {
    const { removedObjects } = await client.uninstall(name, { dropData: options.dropData });
    spinner.stopAndPersist({ symbol: sym.check, text: `Removed ${c.bold(name)}` });
    if (removedObjects.length) {
      log.dim(`    ${sym.dot} dropped ${removedObjects.join(', ')}`);
    }
    writeConfig(recordRemoved(config, name));

    // Vendored code is the user's — unwire it from the barrel (so boot stays
    // clean) but never delete their files.
    if (removeFromBarrel(name)) {
      log.dim(`    ${sym.dot} unwired from blocks/index.ts`);
    }
    if (hasVendoredCode(name)) {
      log.info(`blocks/${name} is your code now — delete the folder if you no longer want it.`);
    }

    log.raw();
    log.success(`${name} has left orbit. ${sym.satellite}`);
  } catch (err) {
    spinner.stopAndPersist({ symbol: sym.cross, text: c.danger(name) });
    reportRemoveError(err, options);
    process.exitCode = 1;
  }
}

/** Surfaces an uninstall failure, hinting at --drop-data on a data-guard conflict. */
function reportRemoveError(err: unknown, options: RemoveOptions): void {
  if (!(err instanceof ApiError)) {
    log.error((err as Error).message);
    return;
  }
  log.error(err.message);
  if (err.status === 409 && !options.dropData && /hold data/i.test(err.message)) {
    log.dim('    Re-run with --drop-data to remove the tables and their rows.');
  }
}
