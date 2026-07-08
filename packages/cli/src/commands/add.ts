/**
 * `ion-drive add <ref>` — resolves a block (and its dependencies) and installs
 * them into the configured server.
 *
 * The shadcn `add` analog, spec-03 edition: parse the ref (`crm`,
 * `crm@^0.2.0`, `@acme/billing@1.x`, a block.json URL, or a local path),
 * resolve the dependency closure across configured registries (ranges
 * collected, highest-satisfying selection, same-registry rule), preview the
 * plan, then install each item in order. Registry items are fetched as **raw
 * artifact bytes** at install time — the seam spec-04's digest verification
 * hooks into — then parsed and POSTed to the server, which validates and
 * applies. The local `ion.config.json` records what was installed
 * (name/version/digest/source/sourceUrl; digest is `null` until spec-04).
 */

import ora from 'ora';
import prompts from 'prompts';
import { ApiError, type InstallReport, IonApiClient } from '../api-client.js';
import {
  ConfigError,
  type IonProjectConfig,
  readConfig,
  recordInstalled,
  writeConfig,
} from '../config.js';
import { BarrelError, addToBarrel, vendorBlockCode } from '../project.js';
import { RefError, parseRef } from '../registry/ref.js';
import {
  type Manifest,
  RegistryError,
  asManifest,
  fetchArtifact,
  fetchBlock,
  fetchIndex,
  fetchManifestFromUrl,
  readLocalBlock,
  resolveRegistry,
  withParams,
} from '../registry/registry-client.js';
import {
  type InstallPlan,
  type PlanItem,
  ResolveError,
  type ResolverIO,
  resolvePlan,
} from '../registry/resolver.js';
import { box, c, gradient, log, orbitSpinner, sym } from '../ui.js';
import { warnOnVersionSkew } from '../version-check.js';

export interface AddOptions {
  yes?: boolean;
  dryRun?: boolean;
  /**
   * One flag, three effects (C10): the server force-reinstalls, the resolver
   * proceeds through installed-version conflicts, and an already-installed
   * root is planned as a reinstall instead of "nothing to do".
   */
  force?: boolean;
  /** Commander's `--no-cache` negation: `cache === false` bypasses cache reads. */
  cache?: boolean;
}

/** Object names a manifest declares (for local/URL plan lines). */
function objectNames(manifest: Manifest): string[] {
  const objects = manifest.objects as { name?: string }[] | undefined;
  return (objects ?? []).map((o) => o.name ?? '?');
}

export async function addCommand(target: string, options: AddOptions): Promise<void> {
  const config = readConfig();
  const client = new IonApiClient(config.serverUrl, config.apiKey);

  const plan = await resolveTarget(client, config, target, options);
  if (!plan) return;
  if (plan.items.length === 0) {
    log.info(`${c.bold(target)} is already installed. Nothing to do.`);
    return;
  }

  renderPlan(target, config.serverUrl, plan, options);

  if (!(await confirmInstall(plan.items.length, options))) return;

  await runInstalls(client, config, plan.items, options);
}

/** Verifies connectivity and resolves the install plan. Returns null on failure. */
async function resolveTarget(
  client: IonApiClient,
  config: IonProjectConfig,
  target: string,
  options: AddOptions,
): Promise<InstallPlan | null> {
  const noCache = options.cache === false;
  const io: ResolverIO = {
    fetchIndex: (reg) => fetchIndex(reg, { noCache }),
    fetchBlock: (reg, name) => fetchBlock(reg, name, { noCache }),
    getLocalOrUrlManifest: (ref) =>
      ref.kind === 'local'
        ? Promise.resolve(readLocalBlock(ref.path))
        : fetchManifestFromUrl(ref.url),
  };

  try {
    const ref = parseRef(target);
    const health = await client.health();
    warnOnVersionSkew(health.version);
    const installed = new Map(
      (await client.listInstalled())
        .filter((b) => b.status === 'installed')
        .map((b) => [b.name, b.version] as const),
    );
    return await resolvePlan(ref, {
      config,
      installed,
      recordedBlocks: config.blocks,
      serverCoreVersion: health.version,
      force: options.force,
      io,
    });
  } catch (err) {
    if (
      err instanceof ApiError ||
      err instanceof RegistryError ||
      err instanceof ResolveError ||
      err instanceof RefError ||
      err instanceof ConfigError
    ) {
      log.error(err.message);
      process.exitCode = 1;
      return null;
    }
    throw err;
  }
}

/** One plan line: `1. crm@0.2.0 · @ion` for registry items; object list for local/URL. */
function planLine(item: PlanItem, index: number): string {
  const tag = item.isDependency ? c.plasma(' (dependency)') : '';
  const label = `${c.meteor(`${index + 1}.`)} ${c.bold(item.name)}${c.meteor(`@${item.version}`)}${tag}`;
  if (item.manifest) {
    const objects = objectNames(item.manifest);
    return `${label} ${c.meteor(`(${item.source})`)}  ${c.dim(`→ ${objects.join(', ') || '(no objects)'}`)}`;
  }
  return `${label} ${c.meteor('·')} ${c.cyan(item.source)}`;
}

/** Prints the install plan preview box. */
function renderPlan(
  target: string,
  serverUrl: string,
  plan: InstallPlan,
  options: AddOptions,
): void {
  const planLines: string[] = [];
  plan.items.forEach((item, i) => {
    planLines.push(planLine(item, i));
    for (const w of item.warnings) planLines.push(`   ${sym.warn} ${c.warn(w)}`);
  });
  if (plan.satisfied.length > 0) {
    planLines.push(c.meteor(`   satisfied: ${plan.satisfied.join(', ')}`));
  }
  for (const w of plan.warnings) planLines.push(`${sym.warn} ${c.warn(w)}`);
  log.raw();
  console.log(
    box(options.dryRun ? 'Install plan (dry run)' : 'Install plan', [
      `${sym.rocket} Installing ${c.bold(target)} into ${c.cyan(serverUrl)}`,
      '',
      ...planLines,
    ]),
  );
}

/** Confirms with the user (skipped for --yes / --dry-run). */
async function confirmInstall(count: number, options: AddOptions): Promise<boolean> {
  if (options.yes || options.dryRun) return true;
  log.raw();
  const { go } = await prompts({
    type: 'confirm',
    name: 'go',
    message: `Install ${count} block${count > 1 ? 's' : ''}?`,
    initial: true,
  });
  if (!go) log.warn('Aborted.');
  return Boolean(go);
}

/**
 * Fetches a plan item's manifest. Registry items pull the immutable artifact
 * as raw bytes with the registry's auth headers/params —
 * `fetchArtifact → (spec-04 digest verification slots in here) → JSON.parse
 * → asManifest`. Local/URL items already carry their manifest.
 */
async function manifestFor(item: PlanItem, config: IonProjectConfig): Promise<Manifest> {
  if (item.manifest) return item.manifest;
  if (!item.registry || !item.sourceUrl) {
    throw new RegistryError(`Plan item "${item.name}" has no manifest source`); // unreachable
  }
  const reg = resolveRegistry(item.registry, config);
  const { bytes } = await fetchArtifact(withParams(item.sourceUrl, reg.params), reg.headers);
  // (spec-04: verify sha256(bytes) against the registry-declared digest here,
  // before anything parses them. Hard fail on mismatch, no --force.)
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RegistryError(`Artifact at ${item.sourceUrl} is not JSON`);
  }
  return asManifest(parsed, item.sourceUrl);
}

/** {@link manifestFor} with friendly failure: logs registry errors, returns null. */
async function safeManifestFor(item: PlanItem, config: IonProjectConfig): Promise<Manifest | null> {
  try {
    return await manifestFor(item, config);
  } catch (err) {
    if (err instanceof RegistryError || err instanceof ConfigError) {
      log.error(err.message);
      return null;
    }
    throw err;
  }
}

/** Installs each item in order, updating the local config and printing a summary. */
async function runInstalls(
  client: IonApiClient,
  config: IonProjectConfig,
  items: PlanItem[],
  options: AddOptions,
): Promise<void> {
  log.raw();
  let updatedConfig = config;
  for (const item of items) {
    const manifest = await safeManifestFor(item, config);
    if (!manifest) {
      process.exitCode = 1;
      return;
    }
    if (!options.dryRun && !(await vendorStep(client, manifest))) {
      process.exitCode = 1;
      return;
    }
    const report = await installOne(client, manifest, options);
    if (!report) {
      process.exitCode = 1;
      return;
    }
    if (!options.dryRun) {
      updatedConfig = recordInstalled(updatedConfig, {
        name: item.name,
        version: item.version,
        digest: null, // spec-04 fills this with the verified sha256
        source: item.source,
        sourceUrl: item.sourceUrl,
      });
    }
  }

  if (!options.dryRun) writeConfig(updatedConfig);

  log.raw();
  log.success(
    gradient(
      options.dryRun
        ? `Dry run complete — ${items.length} block(s) would be installed. ${sym.sparkle}`
        : `Liftoff! ${items.length} block(s) installed. ${sym.rocket}`,
    ),
  );
}

/**
 * The vendoring half of the two-part install (Phase 14): copies the block's
 * code into `blocks/<name>/`, wires the barrel, then waits for the dev server
 * (tsx watch) to reload with the new handlers before the manifest install.
 * Returns false when vendoring is required but cannot complete.
 */
async function vendorStep(client: IonApiClient, manifest: Manifest): Promise<boolean> {
  const files = manifest.code ?? [];
  if (files.length === 0) return true; // schema-only block — nothing to vendor

  const name = String(manifest.name);
  const result = vendorBlockCode(name, files);
  for (const path of result.written) log.raw(`  ${sym.check} ${c.cyan(path)}`);
  if (result.skipped.length > 0) {
    log.dim(`  ${sym.dot} kept existing (never overwritten): ${result.skipped.join(', ')}`);
  }

  try {
    if (addToBarrel(name)) log.raw(`  ${sym.check} wired into ${c.cyan('blocks/index.ts')}`);
  } catch (err) {
    if (err instanceof BarrelError) {
      log.error(err.message);
      return false;
    }
    throw err;
  }

  return waitForHandlers(client, manifest);
}

/** Polls the server until the block's handlers are registered (dev-server reload). */
async function waitForHandlers(client: IonApiClient, manifest: Manifest): Promise<boolean> {
  const name = String(manifest.name);
  const wantedActions = ((manifest.actions ?? []) as { name: string }[]).map((a) => a.name);
  const wantedHooks = ((manifest.hooks ?? []) as { name: string }[]).map((h) => h.name);
  if (wantedActions.length === 0 && wantedHooks.length === 0) return true;

  const spinner = ora({
    text: `Waiting for the dev server to reload ${c.bold(name)}'s handlers…`,
    spinner: orbitSpinner,
  }).start();
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const registered = await client.listRegisteredHandlers();
      const actions = new Set(
        registered.actions.filter((a) => a.block === name).map((a) => a.name),
      );
      const hooks = new Set(registered.hooks.filter((h) => h.block === name).map((h) => h.name));
      if (wantedActions.every((a) => actions.has(a)) && wantedHooks.every((h) => hooks.has(h))) {
        spinner.stopAndPersist({ symbol: sym.check, text: `${c.bold(name)} handlers loaded` });
        return true;
      }
    } catch {
      /* server restarting — keep polling */
    }
    await new Promise((r) => setTimeout(r, 750));
  }

  spinner.stopAndPersist({ symbol: sym.cross, text: c.danger(`${name} handlers not loaded`) });
  log.error(
    `The server never registered ${name}'s handlers. Is "npm run dev" (tsx watch) running in this project? Start it, then re-run: ion-drive add ${name}`,
  );
  return false;
}

/** Installs a single manifest with a spinner, printing its report. Returns null on failure. */
async function installOne(
  client: IonApiClient,
  manifest: Manifest,
  options: AddOptions,
): Promise<InstallReport | null> {
  const spinner = ora({
    text: `${options.dryRun ? 'Previewing' : 'Installing'} ${c.bold(String(manifest.name))}…`,
    spinner: orbitSpinner,
  }).start();

  try {
    const report = await client.install(manifest, { dryRun: options.dryRun, force: options.force });
    spinner.stopAndPersist({
      symbol: sym.check,
      text: `${c.bold(String(manifest.name))} ${c.meteor(`v${report.version}`)}`,
    });
    printReport(report);
    return report;
  } catch (err) {
    spinner.stopAndPersist({ symbol: sym.cross, text: c.danger(String(manifest.name)) });
    if (err instanceof ApiError) {
      log.error(err.message);
      for (const w of err.warnings) log.warn(w);
    } else {
      log.error((err as Error).message);
    }
    return null;
  }
}

/** Prints the notable lines of an install report (indented). */
function printReport(report: InstallReport): void {
  const line = (label: string, items: string[]) => {
    if (items.length) console.log(`    ${sym.dot} ${c.meteor(label)} ${items.join(', ')}`);
  };
  line('objects', report.objectsCreated);
  if (report.objectsSkipped.length) line('reused', report.objectsSkipped);
  line('relationships', report.relationshipsCreated);
  const seeded = Object.entries(report.recordsSeeded).filter(([, n]) => n > 0);
  if (seeded.length) {
    console.log(
      `    ${sym.dot} ${c.meteor('seeded')} ${seeded.map(([k, n]) => `${n} ${k}`).join(', ')}`,
    );
  }
  line('tasks', report.tasksCreated);
  line('roles', report.rolesCreated);
  line('actions', report.actionsExposed ?? []);
  line('hooks', report.hooksExposed ?? []);
  for (const w of report.warnings) console.log(`    ${sym.warn} ${c.warn(w)}`);
}
