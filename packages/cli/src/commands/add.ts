/**
 * `ion-drive add <block>` — resolves a block (and its dependencies) and installs
 * them into the configured server.
 *
 * The shadcn `add` analog: resolve the dependency closure, order it
 * dependencies-first, preview the plan, then POST each manifest to the server —
 * which validates and applies it. Progress is shown with an orbit spinner and a
 * per-block report; the local `ion.config.json` records what was installed.
 */

import ora from 'ora';
import prompts from 'prompts';
import { ApiError, type InstallReport, IonApiClient } from '../api-client.js';
import { readConfig, recordInstalled, writeConfig } from '../config.js';
import { BarrelError, addToBarrel, vendorBlockCode } from '../project.js';
import { type Manifest, RegistryError } from '../registry/registry-client.js';
import { ResolveError, resolvePlan } from '../registry/resolver.js';
import { box, c, gradient, log, orbitSpinner, sym } from '../ui.js';
import { warnOnVersionSkew } from '../version-check.js';

export interface AddOptions {
  yes?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

/** Object names a manifest declares (for the preview). */
function objectNames(manifest: Manifest): string[] {
  const objects = manifest.objects as { name?: string }[] | undefined;
  return (objects ?? []).map((o) => o.name ?? '?');
}

export async function addCommand(target: string, options: AddOptions): Promise<void> {
  const config = readConfig();
  const client = new IonApiClient(config.serverUrl, config.apiKey);

  const plan = await resolveTarget(client, target);
  if (!plan) return;
  if (plan.order.length === 0) {
    log.info(`${c.bold(target)} is already installed. Nothing to do.`);
    return;
  }

  renderPlan(target, config.serverUrl, plan, options);

  if (!(await confirmInstall(plan.order.length, options))) return;

  await runInstalls(client, config, plan.order, options);
}

/** Verifies connectivity and resolves the dependency plan. Returns null on failure. */
async function resolveTarget(
  client: IonApiClient,
  target: string,
): Promise<Awaited<ReturnType<typeof resolvePlan>> | null> {
  try {
    const health = await client.health();
    warnOnVersionSkew(health.version);
    const installedNames = new Set(
      (await client.listInstalled()).filter((b) => b.status === 'installed').map((b) => b.name),
    );
    return await resolvePlan(target, installedNames);
  } catch (err) {
    if (err instanceof ApiError || err instanceof RegistryError || err instanceof ResolveError) {
      log.error(err.message);
      process.exitCode = 1;
      return null;
    }
    throw err;
  }
}

/** Prints the install plan preview box. */
function renderPlan(
  target: string,
  serverUrl: string,
  plan: Awaited<ReturnType<typeof resolvePlan>>,
  options: AddOptions,
): void {
  const planLines = plan.order.map((m, i) => {
    const tag = m.name !== target ? c.plasma(' (dependency)') : '';
    return `${c.meteor(`${i + 1}.`)} ${c.bold(String(m.name))}${tag}  ${c.dim(`→ ${objectNames(m).join(', ')}`)}`;
  });
  if (plan.alreadyInstalled.length > 0) {
    planLines.push(c.meteor(`   satisfied: ${plan.alreadyInstalled.join(', ')}`));
  }
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

/** Installs each manifest in order, updating the local config and printing a summary. */
async function runInstalls(
  client: IonApiClient,
  config: ReturnType<typeof readConfig>,
  order: Manifest[],
  options: AddOptions,
): Promise<void> {
  log.raw();
  let updatedConfig = config;
  for (const manifest of order) {
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
      updatedConfig = recordInstalled(
        updatedConfig,
        String(manifest.name),
        String(manifest.version ?? '0.1.0'),
      );
    }
  }

  if (!options.dryRun) writeConfig(updatedConfig);

  log.raw();
  log.success(
    gradient(
      options.dryRun
        ? `Dry run complete — ${order.length} block(s) would be installed. ${sym.sparkle}`
        : `Liftoff! ${order.length} block(s) installed. ${sym.rocket}`,
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
