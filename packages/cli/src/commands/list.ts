/**
 * `ion-drive list` — shows the block catalog.
 *
 * Renders the bundled catalog as a cosmic table, marking which blocks are
 * already installed on the configured server (when reachable). Dependencies and
 * object counts are shown so the pipeline is legible at a glance.
 */

import { IonApiClient } from '../api-client.js';
import { readConfig } from '../config.js';
import { listAvailable } from '../registry/registry-client.js';
import { c, log, sym, table } from '../ui.js';

export async function listCommand(): Promise<void> {
  const config = readConfig();
  const available = listAvailable();

  // Best-effort: find out which blocks are already installed.
  let installed = new Set<string>();
  try {
    const client = new IonApiClient(config.serverUrl, config.apiKey);
    const rows = await client.listInstalled();
    installed = new Set(rows.filter((b) => b.status === 'installed').map((b) => b.name));
  } catch {
    // Server not reachable — just show the catalog without install status.
  }

  log.heading(`${sym.satellite}  Building Blocks`);

  const rows = available.map((b) => {
    const status = installed.has(b.name)
      ? c.success(`${sym.check} installed`)
      : c.meteor('available');
    const deps = b.dependencies.length ? c.plasma(b.dependencies.join(', ')) : c.meteor('—');
    return [
      `${b.icon ?? sym.orbit} ${c.bold(b.name)}`,
      c.dim(b.description.length > 46 ? `${b.description.slice(0, 45)}…` : b.description),
      String(b.objectCount),
      deps,
      status,
    ];
  });

  console.log(table(['Block', 'Description', 'Objects', 'Requires', 'Status'], rows));
  log.raw();
  log.dim(`  ${sym.star} ${available.length} blocks · target ${config.serverUrl}`);
  log.dim(`  Install with  ${c.star('ion-drive add <block>')}`);
}
