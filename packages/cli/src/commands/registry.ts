/**
 * `ion-drive registry …` — manage the project's configured block registries
 * (spec-03 §5) and generate/administer a registry repo (spec-05 §1).
 *
 *   registry list            table: ns, name, url, block count, staleness
 *   registry add <@ns> <url> validates (fetch + parse the index) then writes config
 *   registry remove <@ns>    refuses while blocks[] records point at it (--force)
 *   registry ping [@ns]      fetch + validate fresh, report generatedAt/latency
 *   registry build [dir]     the registry-JSON generator (--check = CI drift guard)
 *   registry yank <ref>      mark a released version yanked (mutable status edit)
 *   registry deprecate <ref> mark a released version deprecated
 *
 * All subcommands take `--json` (plain `JSON.stringify`, no styling — the
 * LLM-first DX rule). `registry add <@ns>` without a URL is the spec-08
 * directory lookup: the namespace is resolved through the main registry's
 * PR-reviewed `registries.json`, shown for confirmation, then validated and
 * written exactly like the URL form.
 */

import { resolve } from 'node:path';
import prompts from 'prompts';
import {
  BUILT_IN_REGISTRIES,
  ConfigError,
  type IonProjectConfig,
  defaultRegistryNamespace,
  effectiveRegistries,
  readConfig,
  writeConfig,
} from '../config.js';
import {
  type BuildResult,
  RegistryBuildError,
  applyStatusEdit,
  buildRegistry,
  realBuildFs,
} from '../registry/build.js';
import { CORE_REQUIRED_MESSAGE, loadCoreValidator } from '../registry/core-loader.js';
import {
  type RegistriesDirectoryEntry,
  RegistryError,
  type ResolvedRegistry,
  fetchIndex,
  fetchRegistriesDirectory,
  isPermittedRegistryUrl,
  resolveRegistry,
} from '../registry/registry-client.js';
import { c, log, sym, table } from '../ui.js';

/** The namespace grammar (`@acme`) — matches core's directory-entry rule. */
const NAMESPACE_RE = /^@[a-z][a-z0-9-]*$/;

interface JsonOption {
  json?: boolean;
}

/** Prints a payload as plain JSON (the `--json` contract: no chalk, no box). */
function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

/** Uniform failure exit: JSON `{ error }` in --json mode, styled line otherwise. */
function fail(message: string, options: JsonOption): void {
  if (options.json) printJson({ error: message });
  else log.error(message);
  process.exitCode = 1;
}

/** Humanizes how long ago an ISO timestamp was ("3m ago", "2h ago", "5d ago"). */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// --- registry list ------------------------------------------------------------

export interface RegistryListOptions extends JsonOption {
  /** Commander's `--no-cache` negation: `cache === false` means bypass reads. */
  cache?: boolean;
}

/** One row of `registry list` — also the MCP `list_registries` payload. */
export interface RegistryListRow {
  namespace: string;
  url: string;
  isDefault: boolean;
  name?: string;
  blocks?: number;
  generatedAt?: string;
  error?: string;
}

/**
 * Pure row gathering for every configured registry (shared by the command
 * and the registry MCP's `list_registries`). Per-registry fetch failures are
 * error rows, never an abort (spec-03 §5). No logging.
 */
export async function gatherRegistryRows(
  config: IonProjectConfig,
  opts: { noCache?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<RegistryListRow[]> {
  const registries = effectiveRegistries(config);
  const defaultNs = safeDefaultNamespace(config);

  const rows: RegistryListRow[] = [];
  for (const namespace of Object.keys(registries)) {
    const row = {
      namespace,
      url: registries[namespace]?.url ?? '',
      isDefault: namespace === defaultNs,
    };
    try {
      const reg = resolveRegistry(namespace, config);
      const index = await fetchIndex(reg, { noCache: opts.noCache, fetchImpl: opts.fetchImpl });
      rows.push({
        ...row,
        name: index.name,
        blocks: Object.keys(index.blocks).length,
        generatedAt: index.generatedAt,
      });
    } catch (err) {
      rows.push({ ...row, error: (err as Error).message });
    }
  }
  return rows;
}

export async function registryListCommand(options: RegistryListOptions): Promise<void> {
  const config = readConfig();
  const rows = await gatherRegistryRows(config, { noCache: options.cache === false });

  if (options.json) {
    printJson(rows);
    if (rows.some((r) => r.error)) process.exitCode = 1;
    return;
  }

  log.heading(`${sym.satellite}  Block Registries`);
  console.log(
    table(
      ['Registry', 'Name', 'URL', 'Blocks', 'Updated'],
      rows.map((r) => [
        `${c.bold(r.namespace)}${r.isDefault ? c.meteor(' (default)') : ''}`,
        r.error ? c.danger('unreachable') : c.cyan(r.name ?? ''),
        c.dim(r.url),
        r.error ? c.meteor('—') : String(r.blocks ?? 0),
        r.error ? c.meteor('—') : c.meteor(r.generatedAt ? ago(r.generatedAt) : '—'),
      ]),
    ),
  );
  for (const r of rows.filter((row) => row.error)) {
    log.warn(`${r.namespace}: ${r.error}`);
  }
  log.raw();
  log.dim(`  Add one with  ${c.star('ion-drive registry add <@ns> <url>')}`);
  if (rows.some((r) => r.error)) process.exitCode = 1;
}

/** The default namespace, tolerating a broken `defaultRegistry` for display. */
function safeDefaultNamespace(config: IonProjectConfig): string | undefined {
  try {
    return defaultRegistryNamespace(config);
  } catch {
    return undefined;
  }
}

// --- registry add ---------------------------------------------------------------

export interface RegistryAddOptions extends JsonOption {
  /** Skip the directory-lookup confirmation prompt. */
  yes?: boolean;
}

export async function registryAddCommand(
  namespace: string,
  url: string | undefined,
  options: RegistryAddOptions,
): Promise<void> {
  if (!NAMESPACE_RE.test(namespace)) {
    fail(`Invalid namespace "${namespace}" — expected a lowercase handle like "@acme".`, options);
    return;
  }

  // The no-URL form (spec-08 §3): look the namespace up in the main
  // registry's registries.json, confirm, then run the same validate+write
  // path as the URL form.
  let entry: RegistriesDirectoryEntry | undefined;
  let targetUrl = url;
  if (targetUrl === undefined) {
    entry = await lookupDirectoryEntry(namespace, options);
    if (!entry) return; // failure or unknown namespace already reported
    if (!(await confirmDirectoryEntry(entry, options))) return; // declined ⇒ no write
    targetUrl = entry.url;
  }

  if (!isPermittedRegistryUrl(targetUrl)) {
    fail(
      `Refusing ${targetUrl} — registries must be https (http is allowed only for localhost/127.0.0.1).`,
      options,
    );
    return;
  }

  // Validate before writing anything: fetch + parse the index. A legacy
  // (unversioned) index surfaces spec-01's "pre-release format" error here.
  const probe: ResolvedRegistry = { namespace, url: targetUrl, headers: {}, params: {} };
  let indexName: string;
  let blockCount: number;
  try {
    const index = await fetchIndex(probe, { noCache: true });
    indexName = index.name;
    blockCount = Object.keys(index.blocks).length;
  } catch (err) {
    fail((err as Error).message, options);
    return;
  }

  const config = readConfig();
  const registries = { ...config.registries, [namespace]: targetUrl };
  writeConfig({ ...config, registries });

  if (options.json) {
    printJson({
      namespace,
      url: targetUrl,
      name: indexName,
      blocks: blockCount,
      ...(entry ? { fromDirectory: true, owner: entry.owner, trust: entry.trust } : {}),
    });
    return;
  }
  log.success(
    `Added ${c.bold(namespace)} ${sym.arrow} ${c.cyan(indexName)} (${blockCount} block${blockCount === 1 ? '' : 's'})`,
  );
  log.dim(`  Install from it with  ion-drive add ${namespace}/<block>`);
}

/**
 * Resolves `@ns` through the main (default) registry's `registries.json`.
 * Unknown namespaces get the documented hint (the URL form still works and is
 * the private-registry path); an unreachable/malformed directory is a named
 * error. Nothing is written on any failure path.
 */
async function lookupDirectoryEntry(
  namespace: string,
  options: RegistryAddOptions,
): Promise<RegistriesDirectoryEntry | undefined> {
  const config = readConfig();
  try {
    const main = resolveRegistry(undefined, config);
    const { directory } = await fetchRegistriesDirectory(main, { noCache: true });
    const entry = directory.registries.find((r) => r.namespace === namespace);
    if (!entry) {
      fail(
        `${namespace} is not in the registries directory — pass the URL explicitly: ion-drive registry add ${namespace} <url>`,
        options,
      );
      return undefined;
    }
    return entry;
  } catch (err) {
    if (err instanceof RegistryError || err instanceof ConfigError) {
      fail(err.message, options);
      return undefined;
    }
    throw err;
  }
}

/** Shows the directory listing and confirms (skipped for --yes / --json). */
async function confirmDirectoryEntry(
  entry: RegistriesDirectoryEntry,
  options: RegistryAddOptions,
): Promise<boolean> {
  if (options.json || options.yes) return true; // non-interactive modes
  log.info(`${c.bold(entry.namespace)} ${sym.arrow} ${c.cyan(entry.url)}`);
  if (entry.owner) log.bullet(`owner        ${entry.owner}`);
  if (entry.description) log.bullet(`description  ${c.dim(entry.description)}`);
  // Directory trust is a listing review, never a code audit (spec-01 §6).
  if (entry.trust) log.bullet(`trust        ${entry.trust} ${c.dim('(listing review only)')}`);
  const { go } = await prompts({
    type: 'confirm',
    name: 'go',
    message: `Add ${entry.namespace} to ion.config.json?`,
    initial: true,
  });
  if (!go) log.warn('Aborted — nothing written.');
  return Boolean(go);
}

// --- registry remove ---------------------------------------------------------------

export interface RegistryRemoveOptions extends JsonOption {
  force?: boolean;
}

export async function registryRemoveCommand(
  namespace: string,
  options: RegistryRemoveOptions,
): Promise<void> {
  const config = readConfig();
  const configured = config.registries !== undefined && namespace in config.registries;
  const builtIn = namespace in BUILT_IN_REGISTRIES;

  if (!configured) {
    fail(
      builtIn
        ? `${namespace} is built in — only a configured override can be removed (declaring ${namespace} under registries overrides it).`
        : `${namespace} is not configured in ion.config.json.`,
      options,
    );
    return;
  }

  // The guard: installed blocks that came from this registry would lose
  // their update/audit source. --force overrides.
  const dependents = config.blocks.filter((b) => b.source === namespace).map((b) => b.name);
  if (dependents.length > 0 && !options.force) {
    fail(
      `Cannot remove ${namespace}: installed block${dependents.length === 1 ? '' : 's'} ${dependents.join(', ')} came from it. Remove them first, or pass --force to drop the registry anyway.`,
      options,
    );
    return;
  }

  const registries = { ...config.registries };
  delete registries[namespace];
  writeConfig({ ...config, registries });

  const reverted = builtIn ? ' (reverted to the built-in URL)' : '';
  if (options.json) {
    printJson({ namespace, removed: true, revertedToBuiltIn: builtIn });
    return;
  }
  log.success(`Removed ${c.bold(namespace)}${reverted}`);
  if (dependents.length > 0) {
    log.warn(`Blocks still installed from it: ${dependents.join(', ')}`);
  }
}

// --- registry build (spec-05 §1) -------------------------------------------------

export interface RegistryBuildCommandOptions extends JsonOption {
  /** CI mode: run everything, write nothing, fail on any would-be change. */
  check?: boolean;
  /** Limit packing/doc regeneration to one block. */
  block?: string;
}

/**
 * Runs the registry generator over `dir` (default cwd). Core's strict parsers
 * are MANDATORY here — a generator that can't validate refuses to emit.
 * `--json` includes `packed[]` (the publish workflow attests exactly those).
 */
export async function registryBuildCommand(
  dir = '.',
  options: RegistryBuildCommandOptions = {},
): Promise<void> {
  const core = await loadCoreValidator();
  if (!core) {
    fail(CORE_REQUIRED_MESSAGE, options);
    return;
  }

  const root = resolve(dir).split('\\').join('/');
  const result = buildRegistry(root, {
    fs: realBuildFs(),
    validator: core,
    check: options.check,
    block: options.block,
  });

  const failed =
    result.refusals.length > 0 ||
    (options.check === true && result.wrote.length + result.deleted.length > 0);
  if (options.json) {
    printJson({ ...result, check: options.check === true, ok: !failed });
    if (failed) process.exitCode = 1;
    return;
  }
  renderBuildResult(result, options.check === true);
}

/** Human rendering of a build (or --check) outcome; sets the exit code. */
function renderBuildResult(result: BuildResult, check: boolean): void {
  for (const warning of result.warnings) log.warn(warning);
  for (const refusal of result.refusals) log.error(refusal);
  for (const packed of result.packed) {
    log.bullet(
      `${c.bold(packed.name)}${c.meteor(`@${packed.version}`)} ${sym.arrow} ${c.cyan(packed.artifactPath)} ${c.dim(packed.digest)}`,
    );
  }

  if (result.refusals.length > 0) {
    log.error('registry build refused — nothing was written.');
    process.exitCode = 1;
    return;
  }
  if (check) {
    renderCheckOutcome(result.wrote, result.deleted);
    return;
  }
  if (result.wrote.length + result.deleted.length === 0) {
    log.success('Registry is up to date — nothing to write.');
    return;
  }
  for (const path of result.wrote) log.raw(`  ${sym.check} ${c.cyan(path)}`);
  for (const path of result.deleted) log.raw(`  ${sym.cross} ${c.meteor(`${path} (removed)`)}`);
  log.success(
    `Registry built — ${result.packed.length} new artifact(s), ${result.wrote.length} file(s) written${result.deleted.length > 0 ? `, ${result.deleted.length} removed` : ''}.`,
  );
}

/** The --check verdict: any would-be change (write OR delete) fails, listed. */
function renderCheckOutcome(wouldWrite: string[], wouldDelete: string[]): void {
  if (wouldWrite.length + wouldDelete.length > 0) {
    log.error(`--check: ${wouldWrite.length + wouldDelete.length} file(s) would change:`);
    for (const path of wouldWrite) log.bullet(c.cyan(path));
    for (const path of wouldDelete) log.bullet(c.meteor(`${path} (would be removed)`));
    process.exitCode = 1;
    return;
  }
  log.success('Registry is up to date (nothing would change).');
}

// --- registry yank / deprecate ----------------------------------------------------

export interface StatusEditCommandOptions extends JsonOption {
  reason?: string;
}

/** Shared implementation of the two mutable-status editors. */
async function statusEditCommand(
  ref: string,
  status: 'yanked' | 'deprecated',
  options: StatusEditCommandOptions,
): Promise<void> {
  try {
    const result = applyStatusEdit(process.cwd().split('\\').join('/'), ref, status, {
      fs: realBuildFs(),
      reason: options.reason,
    });
    if (options.json) {
      printJson(result);
      return;
    }
    log.success(
      `${c.bold(`${result.name}@${result.version}`)} is now ${c.warn(status)}${options.reason ? ` (${options.reason})` : ''}`,
    );
    log.bullet(`latest is now ${c.cyan(result.latest)}`);
    log.dim('  Commit and push the registry checkout to publish the status change.');
  } catch (err) {
    if (err instanceof RegistryBuildError) {
      fail(err.message, options);
      return;
    }
    throw err;
  }
}

export function registryYankCommand(ref: string, options: StatusEditCommandOptions): Promise<void> {
  return statusEditCommand(ref, 'yanked', options);
}

export function registryDeprecateCommand(
  ref: string,
  options: StatusEditCommandOptions,
): Promise<void> {
  return statusEditCommand(ref, 'deprecated', options);
}

// --- registry ping ---------------------------------------------------------------

export async function registryPingCommand(
  namespace: string | undefined,
  options: JsonOption,
): Promise<void> {
  const config = readConfig();
  let reg: ResolvedRegistry;
  try {
    reg = resolveRegistry(namespace, config);
  } catch (err) {
    if (err instanceof RegistryError || err instanceof ConfigError) {
      fail(err.message, options);
      return;
    }
    throw err;
  }

  const started = Date.now();
  try {
    // Ping always hits the network — the point is "is it up right now" (C4).
    const index = await fetchIndex(reg, { noCache: true });
    const latencyMs = Date.now() - started;
    const blocks = Object.keys(index.blocks).length;
    if (options.json) {
      printJson({
        namespace: reg.namespace,
        url: reg.url,
        name: index.name,
        generatedAt: index.generatedAt,
        blocks,
        latencyMs,
      });
      return;
    }
    log.success(`${c.bold(reg.namespace)} ${sym.arrow} ${c.cyan(index.name)}`);
    log.bullet(`url        ${c.dim(reg.url)}`);
    log.bullet(`generated  ${index.generatedAt} ${c.meteor(`(${ago(index.generatedAt)})`)}`);
    log.bullet(`blocks     ${blocks}`);
    log.bullet(`latency    ${latencyMs}ms`);
  } catch (err) {
    fail((err as Error).message, options);
  }
}
