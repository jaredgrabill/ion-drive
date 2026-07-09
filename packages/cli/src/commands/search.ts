/**
 * `ion-drive search <term>` — find blocks in a configured registry (spec-08 §2).
 *
 * Searches the project's **default registry** unless `--registry @ns` names
 * another configured one. Uses the registry's prebuilt search index when its
 * `index.json` advertises `searchUrl`; otherwise (or when the index is
 * unusable, with a warning) falls back to substring matching over the
 * registry index — so every protocol-v1 registry is searchable. `--json` is
 * machine-pure (the LLM-first DX rule); human output is a table with the
 * display-hint trust badge and an `ion-drive add` hint.
 */

import { ConfigError, defaultRegistryNamespace, readConfig } from '../config.js';
import {
  RegistryError,
  type ResolvedRegistry,
  resolveRegistry,
} from '../registry/registry-client.js';
import { type SearchHit, type SearchResult, searchRegistry } from '../registry/search.js';
import { c, log, sym, table } from '../ui.js';

export interface SearchOptions {
  /** Search one configured registry (`--registry @acme`); default otherwise. */
  registry?: string;
  json?: boolean;
  /** Commander's `--no-cache` negation: `cache === false` bypasses cache reads. */
  cache?: boolean;
}

/** Prints a payload as plain JSON (the `--json` contract: no chalk, no box). */
function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

/** Uniform failure exit: JSON `{ error }` in --json mode, styled line otherwise. */
function fail(message: string, options: SearchOptions): void {
  if (options.json) printJson({ error: message });
  else log.error(message);
  process.exitCode = 1;
}

export async function searchCommand(term: string, options: SearchOptions = {}): Promise<void> {
  const config = readConfig();

  let reg: ResolvedRegistry;
  let result: SearchResult;
  try {
    reg = resolveRegistry(options.registry, config);
    result = await searchRegistry(term, reg, { noCache: options.cache === false });
  } catch (err) {
    if (err instanceof RegistryError || err instanceof ConfigError) {
      fail(err.message, options);
      return;
    }
    throw err;
  }

  // The add hint: bare names resolve in the default registry; anything else
  // needs the namespace spelled out.
  const isDefault = safeDefaultNamespace(config) === reg.namespace;
  const addRef = (name: string): string => (isDefault ? name : `${reg.namespace}/${name}`);

  if (options.json) {
    printJson({
      term,
      ...result,
      hits: result.hits.map((h) => ({ ...h, addRef: addRef(h.name) })),
    });
    return;
  }

  for (const warning of result.warnings) log.warn(warning);
  if (result.hits.length === 0) {
    // Not an error: an empty search is a normal answer (exit 0).
    log.info(
      `No blocks matching ${c.bold(term)} in ${c.bold(reg.namespace)} ${c.dim(`(${reg.url})`)}.`,
    );
    log.dim(`  Browse everything with  ${c.star('ion-drive list')}`);
    return;
  }

  log.heading(`${sym.satellite}  Blocks matching "${term}"`);
  console.log(
    table(
      ['Block', 'Description', 'Latest', 'Matched'],
      result.hits.map((hit) => [
        `${sym.orbit} ${c.bold(hit.name)}${trustBadge(hit)}`,
        c.dim(clip(hit.description ?? hit.title ?? '', 46)),
        c.cyan(hit.latest),
        c.meteor(hit.matchedVia),
      ]),
    ),
  );
  log.raw();
  log.dim(
    `  ${sym.star} ${result.hits.length} hit${result.hits.length === 1 ? '' : 's'} · ${reg.namespace} · via ${result.source === 'search-index' ? 'search index' : 'registry index'}`,
  );
  const first = result.hits[0];
  if (first) log.dim(`  Install with  ${c.star(`ion-drive add ${addRef(first.name)}`)}`);
}

/** The index's display-hint trust, marked "(claimed)" like `ion-drive list`. */
function trustBadge(hit: SearchHit): string {
  return hit.trust ? c.dim(` ${hit.trust} (claimed)`) : '';
}

/** Truncates a cell to `max` visible characters with an ellipsis. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The default namespace, tolerating a broken `defaultRegistry` for display. */
function safeDefaultNamespace(config: ReturnType<typeof readConfig>): string | undefined {
  try {
    return defaultRegistryNamespace(config);
  } catch {
    return undefined;
  }
}
