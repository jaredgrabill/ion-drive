/**
 * `ion-drive list` — shows the block registry catalog.
 *
 * Renders the registry index as a cosmic table, marking which blocks are
 * already installed on the configured server (when reachable). The registry is
 * a flat JSON index (Phase 14 Tier 4) — override it with `ION_DRIVE_REGISTRY`
 * or `registryUrl` in `ion.config.json`.
 */

import { IonApiClient } from '../api-client.js';
import { readConfig } from '../config.js';
import { RegistryError, listAvailable, registryUrl } from '../registry/registry-client.js';
import { c, log, sym, table } from '../ui.js';

export async function listCommand(): Promise<void> {
  const config = readConfig();

  let available: Awaited<ReturnType<typeof listAvailable>>;
  try {
    available = await listAvailable();
  } catch (err) {
    if (err instanceof RegistryError) {
      log.error(err.message);
      log.dim(`  Registry: ${registryUrl()}`);
      log.dim(`  Blocks can still be added by URL or local path: ${c.star('ion-drive add <ref>')}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  if (available.length === 0) {
    log.warn('The registry lists no blocks yet — add by URL or local path instead.');
    log.dim(`  Registry: ${registryUrl()}`);
    return;
  }

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
      `${sym.orbit} ${c.bold(b.name)}`,
      c.dim(b.description.length > 46 ? `${b.description.slice(0, 45)}…` : b.description),
      c.cyan(b.version),
      deps,
      status,
    ];
  });

  console.log(table(['Block', 'Description', 'Latest', 'Requires', 'Status'], rows));
  log.raw();
  log.dim(`  ${sym.star} ${available.length} blocks · registry ${registryUrl()}`);
  log.dim(`  Install with  ${c.star('ion-drive add <block>')}`);
}
