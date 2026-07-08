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
 * directory lookup — a friendly not-yet error here.
 */

import { resolve } from 'node:path';
import {
  BUILT_IN_REGISTRIES,
  ConfigError,
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
  RegistryError,
  type ResolvedRegistry,
  fetchIndex,
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

export async function registryListCommand(options: RegistryListOptions): Promise<void> {
  const config = readConfig();
  const registries = effectiveRegistries(config);
  const defaultNs = safeDefaultNamespace();
  const noCache = options.cache === false;

  // Per-registry fetch failures are error rows, never an abort (spec §5).
  const rows: {
    namespace: string;
    url: string;
    isDefault: boolean;
    name?: string;
    blocks?: number;
    generatedAt?: string;
    error?: string;
  }[] = [];
  for (const namespace of Object.keys(registries)) {
    const row = {
      namespace,
      url: registries[namespace]?.url ?? '',
      isDefault: namespace === defaultNs,
    };
    try {
      const reg = resolveRegistry(namespace, config);
      const index = await fetchIndex(reg, { noCache });
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
function safeDefaultNamespace(): string | undefined {
  try {
    return defaultRegistryNamespace(readConfig());
  } catch {
    return undefined;
  }
}

// --- registry add ---------------------------------------------------------------

export async function registryAddCommand(
  namespace: string,
  url: string | undefined,
  options: JsonOption,
): Promise<void> {
  if (!NAMESPACE_RE.test(namespace)) {
    fail(`Invalid namespace "${namespace}" — expected a lowercase handle like "@acme".`, options);
    return;
  }
  if (url === undefined) {
    // The main registry's registries.json directory lookup is spec-08 (M2).
    fail(
      `Looking up ${namespace} in the registries directory ships in a later release (spec-08) — pass its index URL: ion-drive registry add ${namespace} <url>`,
      options,
    );
    return;
  }
  if (!isPermittedRegistryUrl(url)) {
    fail(
      `Refusing ${url} — registries must be https (http is allowed only for localhost/127.0.0.1).`,
      options,
    );
    return;
  }

  // Validate before writing anything: fetch + parse the index. A legacy
  // (unversioned) index surfaces spec-01's "pre-release format" error here.
  const probe: ResolvedRegistry = { namespace, url, headers: {}, params: {} };
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
  const registries = { ...config.registries, [namespace]: url };
  writeConfig({ ...config, registries });

  if (options.json) {
    printJson({ namespace, url, name: indexName, blocks: blockCount });
    return;
  }
  log.success(
    `Added ${c.bold(namespace)} ${sym.arrow} ${c.cyan(indexName)} (${blockCount} block${blockCount === 1 ? '' : 's'})`,
  );
  log.dim(`  Install from it with  ion-drive add ${namespace}/<block>`);
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

  const failed = result.refusals.length > 0 || (options.check === true && result.wrote.length > 0);
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
    renderCheckOutcome(result.wrote);
    return;
  }
  if (result.wrote.length === 0) {
    log.success('Registry is up to date — nothing to write.');
    return;
  }
  for (const path of result.wrote) log.raw(`  ${sym.check} ${c.cyan(path)}`);
  log.success(
    `Registry built — ${result.packed.length} new artifact(s), ${result.wrote.length} file(s) written.`,
  );
}

/** The --check verdict: any would-be change is a failure listing the files. */
function renderCheckOutcome(wouldWrite: string[]): void {
  if (wouldWrite.length > 0) {
    log.error(`--check: ${wouldWrite.length} file(s) would change:`);
    for (const path of wouldWrite) log.bullet(c.cyan(path));
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
