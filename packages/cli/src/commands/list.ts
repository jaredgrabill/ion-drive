/**
 * `ion-drive list` — shows a registry's block catalog (spec-03 §6).
 *
 * By default the project's **default registry** (usually `@ion`); `--registry
 * @ns` lists another configured one; `--all` walks every configured registry
 * (per-registry failures are reported, never abort the walk). Columns come
 * from the protocol-v1 `index.json` summary — the index has no per-version
 * data (that lives in `blocks/<name>.json`), so there is no "Requires"
 * column. Blocks already installed on the configured server are marked when
 * it's reachable.
 */

import { IonApiClient } from '../api-client.js';
import { ConfigError, type IonProjectConfig, effectiveRegistries, readConfig } from '../config.js';
import {
  RegistryError,
  type RegistryIndexDoc,
  fetchIndex,
  resolveRegistry,
} from '../registry/registry-client.js';
import { c, log, sym, table } from '../ui.js';

export interface ListOptions {
  /** List one configured registry (`--registry @acme`). */
  registry?: string;
  /** Walk every configured registry. */
  all?: boolean;
  /** Commander's `--no-cache` negation: `cache === false` bypasses cache reads. */
  cache?: boolean;
}

interface CatalogSection {
  namespace: string;
  url: string;
  index?: RegistryIndexDoc;
  error?: string;
}

export async function listCommand(options: ListOptions = {}): Promise<void> {
  const config = readConfig();
  const noCache = options.cache === false;

  const namespaces = options.all
    ? Object.keys(effectiveRegistries(config))
    : [options.registry].filter((ns): ns is string => ns !== undefined);

  const sections = await fetchCatalogs(config, namespaces, noCache);
  if (!sections) return;

  const anyBlocks = sections.some((s) => Object.keys(s.index?.blocks ?? {}).length > 0);
  if (!anyBlocks && sections.every((s) => !s.error)) {
    log.warn('No blocks listed yet — add by URL or local path instead.');
    for (const s of sections) log.dim(`  Registry: ${s.namespace} ${s.url}`);
    return;
  }

  const installed = await installedNames(config);
  renderCatalog(sections, installed, options);
}

/** Resolves + fetches each requested registry; `[]` namespace list = default. */
async function fetchCatalogs(
  config: IonProjectConfig,
  namespaces: string[],
  noCache: boolean,
): Promise<CatalogSection[] | null> {
  const targets = namespaces.length > 0 ? namespaces : [undefined];
  const sections: CatalogSection[] = [];
  for (const ns of targets) {
    let namespace = ns ?? '';
    let url = '';
    try {
      const reg = resolveRegistry(ns, config);
      namespace = reg.namespace;
      url = reg.url;
      sections.push({ namespace, url, index: await fetchIndex(reg, { noCache }) });
    } catch (err) {
      if (!(err instanceof RegistryError || err instanceof ConfigError)) throw err;
      // A single explicit registry failing is fatal; under --all it's a row.
      if (targets.length === 1) {
        log.error(err.message);
        log.dim(
          `  Blocks can still be added by URL or local path: ${c.star('ion-drive add <ref>')}`,
        );
        process.exitCode = 1;
        return null;
      }
      sections.push({ namespace, url, error: err.message });
    }
  }
  return sections;
}

/** Best-effort: which blocks the configured server already has installed. */
async function installedNames(config: IonProjectConfig): Promise<Set<string>> {
  try {
    const client = new IonApiClient(config.serverUrl, config.apiKey);
    const rows = await client.listInstalled();
    return new Set(rows.filter((b) => b.status === 'installed').map((b) => b.name));
  } catch {
    return new Set(); // server not reachable — show the catalog without status
  }
}

/** Truncates a cell to `max` visible characters with an ellipsis. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Table rows for one registry section (an unreachable one is a single error row). */
function sectionRows(section: CatalogSection, installed: Set<string>, all?: boolean): string[][] {
  if (section.error) {
    return [
      [
        `${sym.orbit} ${c.danger(section.namespace || '?')}`,
        c.danger(clip(section.error, 60)),
        ...(all ? [c.meteor('—')] : []),
        c.meteor('—'),
        c.meteor('—'),
      ],
    ];
  }
  return Object.entries(section.index?.blocks ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => [
      // The index `trust` field is a DISPLAY HINT only — real tiers are
      // computed by the CLI at add/verify time (spec-04), hence "(claimed)".
      `${sym.orbit} ${c.bold(name)}${entry.trust ? c.dim(` ${entry.trust} (claimed)`) : ''}`,
      c.dim(clip(entry.description ?? '', 46)),
      ...(all ? [c.plasma(section.namespace)] : []),
      c.cyan(entry.latest),
      installed.has(name) ? c.success(`${sym.check} installed`) : c.meteor('available'),
    ]);
}

/** Renders the catalog table (a Registry column appears under --all). */
function renderCatalog(
  sections: CatalogSection[],
  installed: Set<string>,
  options: ListOptions,
): void {
  log.heading(`${sym.satellite}  Building Blocks`);

  const rows = sections.flatMap((section) => sectionRows(section, installed, options.all));
  const headers = options.all
    ? ['Block', 'Description', 'Registry', 'Latest', 'Status']
    : ['Block', 'Description', 'Latest', 'Status'];
  console.log(table(headers, rows));
  log.raw();
  for (const s of sections.filter((section) => !section.error)) {
    const count = Object.keys(s.index?.blocks ?? {}).length;
    log.dim(`  ${sym.star} ${count} block${count === 1 ? '' : 's'} · ${s.namespace} ${s.url}`);
  }
  log.dim(`  Install with  ${c.star('ion-drive add <block>')}`);
  if (sections.some((s) => s.error)) process.exitCode = 1;
}
