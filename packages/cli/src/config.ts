/**
 * Local project configuration for the CLI (`ion.config.json`).
 *
 * `ion-drive init` writes this file; `add`/`remove`/`list` read it to find the
 * target server and credentials. It also records which blocks the project has
 * installed (a local mirror of the server's ledger) so the consumer owns a
 * checked-in record of their block set — the shadcn "you own your code" ethos.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CONFIG_FILENAME = 'ion.config.json';

export interface InstalledBlockRecord {
  name: string;
  version: string;
  installedAt: string;
}

export interface IonProjectConfig {
  /** Base URL of the target Ion Drive server. */
  serverUrl: string;
  /** API key (`iond_…`) used to authenticate management calls, if any. */
  apiKey?: string;
  /** Blocks installed into this project (local mirror of the server ledger). */
  blocks: InstalledBlockRecord[];
}

const DEFAULTS: IonProjectConfig = {
  serverUrl: 'http://localhost:3000',
  blocks: [],
};

/** Absolute path to `ion.config.json` in (or above) the given directory. */
export function configPath(dir = process.cwd()): string {
  return join(resolve(dir), CONFIG_FILENAME);
}

export function configExists(dir = process.cwd()): boolean {
  return existsSync(configPath(dir));
}

/** Reads the project config, applying defaults for any missing fields. */
export function readConfig(dir = process.cwd()): IonProjectConfig {
  const path = configPath(dir);
  if (!existsSync(path)) return { ...DEFAULTS };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IonProjectConfig>;
  return { ...DEFAULTS, ...parsed, blocks: parsed.blocks ?? [] };
}

/** Writes the project config back to disk (pretty-printed). */
export function writeConfig(config: IonProjectConfig, dir = process.cwd()): void {
  writeFileSync(configPath(dir), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** Records (or updates) an installed block in the local config. */
export function recordInstalled(
  config: IonProjectConfig,
  name: string,
  version: string,
): IonProjectConfig {
  const blocks = config.blocks.filter((b) => b.name !== name);
  blocks.push({ name, version, installedAt: new Date().toISOString() });
  blocks.sort((a, b) => a.name.localeCompare(b.name));
  return { ...config, blocks };
}

/** Removes a block record from the local config. */
export function recordRemoved(config: IonProjectConfig, name: string): IonProjectConfig {
  return { ...config, blocks: config.blocks.filter((b) => b.name !== name) };
}
