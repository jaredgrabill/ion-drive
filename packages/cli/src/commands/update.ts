/**
 * `ion-drive update <name>` — apply a block update end-to-end (spec-07 §3):
 *
 *  1. render the full diff (manifest delta + previews + code table + trailer)
 *     and confirm;
 *  2. **dependencies first** — unsatisfied dep ranges refuse with the ordered
 *     plan; `--with-deps` performs them (each through this same flow,
 *     aborting on the first failure);
 *  3. **code applies before the real install** (the new handlers must be
 *     loaded for the server's requires validation): safe files overwritten,
 *     user-modified files get `<file>.new` beside them (never over — ADR-018),
 *     removed-upstream files listed, barrel re-wired, then wait for the dev
 *     server to reload the handlers;
 *  4. server dry-run first; destructive changes need `--force` (re-dry-run,
 *     re-render the server preview, final confirm; `--drop-data` extends
 *     force past the non-empty-object guard);
 *  5. real `install?upgrade=true`, then `ion.config.json` records the new
 *     version/digest/source. The exit summary mirrors `add`'s.
 */

import ora from 'ora';
import prompts from 'prompts';
import { type InstallReport, IonApiClient } from '../api-client.js';
import { readConfig, recordInstalled, writeConfig } from '../config.js';
import { BarrelError, VendorError, addToBarrel, applyCodeUpdates } from '../project.js';
import type { Manifest } from '../registry/registry-client.js';
import { c, gradient, log, orbitSpinner, sym } from '../ui.js';
import { warnOnVersionSkew } from '../version-check.js';
import { printReport, sourceFor, waitForHandlers } from './add.js';
import { failFriendly, renderDiff } from './diff.js';
import {
  type UpdateTarget,
  codeFileStatuses,
  readVendoredTree,
  renderPreviews,
  resolveUpdateTarget,
} from './update-shared.js';

export interface UpdateOptions {
  version?: string;
  yes?: boolean;
  /** Apply destructive manifest changes (mirrors the server's gate). */
  force?: boolean;
  /** Perform required dependency updates first, in order. */
  withDeps?: boolean;
  /** With --force: drop removed objects even when they still hold rows. */
  dropData?: boolean;
  /** Plain JSON output (non-interactive — implies --yes). */
  json?: boolean;
  /** Commander's `--no-verify-provenance` negation. */
  verifyProvenance?: boolean;
}

export async function updateCommand(name: string, options: UpdateOptions): Promise<void> {
  const client = new IonApiClient(readConfig().serverUrl, readConfig().apiKey);
  // Rule 7 (LLM-first DX): --json keeps stdout machine-pure. All the human
  // progress in this flow goes through console.log (the `log.*` helpers), so
  // route it to stderr for the duration; the JSON results are written
  // straight to process.stdout ({@link emitJson}). Spinners already use
  // stderr (ora's default).
  const originalConsoleLog = console.log;
  if (options.json) console.log = (...args: unknown[]) => console.error(...args);
  try {
    const health = await client.health();
    warnOnVersionSkew(health.version);
    const ok = await runUpdate(client, name, options.version, options, health.version, new Set());
    if (!ok) process.exitCode = 1;
  } catch (err) {
    failFriendly(err);
  } finally {
    console.log = originalConsoleLog;
  }
}

/** Writes a machine-pure JSON document to stdout (bypasses the --json redirect). */
function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * One block's update flow. `visiting` guards `--with-deps` recursion against
 * dependency cycles. Returns false on refusal/abort (exit code set by caller).
 */
async function runUpdate(
  client: IonApiClient,
  name: string,
  selector: string | undefined,
  options: UpdateOptions,
  serverVersion: string,
  visiting: Set<string>,
): Promise<boolean> {
  if (visiting.has(name)) {
    log.error(`Circular dependency chain while updating "${name}" — aborting.`);
    return false;
  }
  visiting.add(name);

  // Re-read per round: a dependency update may have rewritten ion.config.json.
  const config = readConfig();
  const target = await resolveUpdateTarget(name, selector, config, client, {
    verifyProvenance: options.verifyProvenance !== false,
  });
  // Same-version early return — but NEVER for a failed server row (AC4): the
  // ledger version alone doesn't prove the schema matches; let the server's
  // upgrade gates recompute and answer authoritatively.
  if (
    target.verified.item.version === target.currentVersion &&
    target.installed.status !== 'failed'
  ) {
    if (options.json) {
      emitJson({ updated: name, version: target.currentVersion, upToDate: true });
    } else {
      log.info(`${c.bold(name)} is already at ${c.bold(target.currentVersion)} — nothing to do.`);
    }
    return true;
  }

  // 1. The full diff, then the primary confirmation (suppressed under --json:
  //    stdout stays machine-pure and --json implies --yes anyway).
  if (!options.json) await renderDiff(client, target, serverVersion, { json: false });
  if (
    !(await confirm(
      `Update ${name} ${target.currentVersion} → ${target.verified.item.version}?`,
      options,
    ))
  ) {
    return false;
  }

  // 2. Dependencies first.
  if (!(await handleDependencies(client, target, options, serverVersion, visiting))) return false;

  // 3. Code applies BEFORE the real install (handlers must load for
  //    requires validation). This also runs before the server dry-run so the
  //    dry-run's requirement warnings reflect the freshly vendored handlers.
  if (!(await applyCode(client, target))) return false;

  // 4/5. Server dry-run → force gate → real install.
  const report = await installUpgrade(client, target, options);
  if (!report) return false;

  recordUpdated(target);
  summarize(target, report, options);
  return true;
}

/** Step 2: refuse with the ordered plan, or perform the chain (--with-deps). */
async function handleDependencies(
  client: IonApiClient,
  target: UpdateTarget,
  options: UpdateOptions,
  serverVersion: string,
  visiting: Set<string>,
): Promise<boolean> {
  if (target.dependencyNotes.length === 0) return true;
  if (!options.withDeps) {
    log.error(
      `${target.name}@${target.verified.item.version} needs dependency updates first. The ordered plan:`,
    );
    for (const dep of target.dependencyNotes) {
      log.raw(
        `  ${sym.dot} run: ${c.bold(`ion-drive update ${dep.name}`)} ${c.dim(`(needs ${dep.range})`)}`,
      );
    }
    log.raw(`  ${sym.dot} then retry: ${c.bold(`ion-drive update ${target.name}`)}`);
    log.dim('  (or re-run with --with-deps to perform the chain now)');
    return false;
  }
  for (const dep of target.dependencyNotes) {
    log.info(`Updating dependency ${c.bold(dep.name)} (needs ${dep.range})…`);
    const ok = await runUpdate(client, dep.name, dep.range, options, serverVersion, visiting);
    if (!ok) {
      log.error(`Dependency update for "${dep.name}" failed — aborting the chain.`);
      return false;
    }
  }
  return true;
}

/** Step 3: vendor code updates + barrel + wait for the handler reload. */
async function applyCode(client: IonApiClient, target: UpdateTarget): Promise<boolean> {
  const oldCode = (target.installed.manifest?.code ?? []) as { path: string; contents: string }[];
  const manifest = target.verified.manifest;
  const newCode = (manifest.code ?? []) as { path: string; contents: string }[];
  const statuses = codeFileStatuses(oldCode, newCode, readVendoredTree(target.name));

  let applied: ReturnType<typeof applyCodeUpdates>;
  try {
    applied = applyCodeUpdates(target.name, statuses);
  } catch (err) {
    if (err instanceof VendorError) {
      log.error(err.message);
      return false;
    }
    throw err;
  }
  reportAppliedCode(applied);

  if (newCode.length > 0 && !wireBarrel(target.name)) return false;
  return waitForHandlers(client, manifest);
}

/** Prints what the code-apply step did, path by path. */
function reportAppliedCode(applied: ReturnType<typeof applyCodeUpdates>): void {
  for (const path of applied.written) log.raw(`  ${sym.check} ${c.cyan(path)}`);
  if (applied.newFiles.length > 0) {
    log.warn(
      `${applied.newFiles.length} file(s) need a manual merge — your copies are untouched; review and delete the .new files:`,
    );
    for (const path of applied.newFiles) log.raw(`  ${sym.dot} ${c.warn(path)}`);
  }
  for (const path of applied.removedUpstream) {
    log.dim(`  ${sym.dot} ${path} was removed upstream — delete it if you don't use it.`);
  }
}

/** Ensures the block is wired into blocks/index.ts; false = actionable failure. */
function wireBarrel(blockName: string): boolean {
  try {
    if (addToBarrel(blockName)) log.raw(`  ${sym.check} wired into ${c.cyan('blocks/index.ts')}`);
    return true;
  } catch (err) {
    if (err instanceof BarrelError) {
      log.error(err.message);
      return false;
    }
    throw err;
  }
}

/** Steps 4+5: dry-run, destructive gate (--force re-dry-run + final confirm), real install. */
async function installUpgrade(
  client: IonApiClient,
  target: UpdateTarget,
  options: UpdateOptions,
): Promise<InstallReport | null> {
  const manifest = target.verified.manifest as Manifest;
  const source = sourceFor(target.verified);

  let dry = await client.install(manifest, { dryRun: true, upgrade: true, source });
  let useForce = false;
  let useDropData = false;

  const skipped = dry.skippedDestructive ?? [];
  if (skipped.length > 0 && options.force) {
    // Re-dry-run WITH force so the server previews the destructive DDL, then
    // re-render its preview and confirm one final time (spec-07 §3.3).
    useForce = true;
    useDropData = options.dropData ?? false;
    dry = await client.install(manifest, {
      dryRun: true,
      upgrade: true,
      force: true,
      dropData: useDropData,
      source,
    });
    log.raw();
    log.warn('--force will APPLY these destructive changes:');
    for (const line of renderPreviews(dry.previews)) console.log(line);
    for (const w of dry.warnings) log.warn(w);
    if (!(await confirm(`Apply the destructive changes to ${target.name}?`, options))) return null;
  } else if (skipped.length > 0) {
    log.warn('Destructive changes will be SKIPPED (re-run with --force to apply):');
    for (const item of skipped) log.raw(`  ${sym.dot} ${c.warn(item)}`);
  }

  const spinner = ora({
    text: `Updating ${c.bold(target.name)} to ${c.bold(target.verified.item.version)}…`,
    spinner: orbitSpinner,
  }).start();
  try {
    const report = await client.install(manifest, {
      upgrade: true,
      force: useForce,
      dropData: useDropData,
      source,
    });
    spinner.stopAndPersist({
      symbol: sym.check,
      text: `${c.bold(target.name)} ${c.meteor(`v${report.version}`)}`,
    });
    return report;
  } catch (err) {
    spinner.stopAndPersist({ symbol: sym.cross, text: c.danger(target.name) });
    failFriendly(err);
    return null;
  }
}

/** Records the new version/digest/source in ion.config.json (the lockfile). */
function recordUpdated(target: UpdateTarget): void {
  const updated = recordInstalled(readConfig(), {
    name: target.name,
    version: target.verified.item.version,
    digest: target.verified.computedDigest,
    source: target.verified.item.source,
    sourceUrl: target.verified.item.sourceUrl,
  });
  writeConfig(updated);
}

/** The exit summary, mirroring `add`'s. */
function summarize(target: UpdateTarget, report: InstallReport, options: UpdateOptions): void {
  if (options.json) {
    emitJson({ updated: target.name, report });
    return;
  }
  printReport(report);
  const line = (label: string, items: string[] | undefined) => {
    if (items?.length) console.log(`    ${sym.dot} ${c.meteor(label)} ${items.join(', ')}`);
  };
  line('released to you', report.released);
  line('skipped (destructive)', report.skippedDestructive);
  line('tasks updated', report.tasksUpdated);
  line('tasks removed', report.tasksRemoved);
  line('webhooks updated', report.webhooksUpdated);
  line('webhooks removed', report.webhooksRemoved);
  log.raw();
  log.success(
    gradient(
      `${target.name} updated ${target.currentVersion} → ${target.verified.item.version}. ${sym.rocket}`,
    ),
  );
}

/** Confirmation prompt (auto-yes for --yes and --json). */
async function confirm(message: string, options: UpdateOptions): Promise<boolean> {
  if (options.yes || options.json) return true;
  log.raw();
  const { go } = await prompts({ type: 'confirm', name: 'go', message, initial: true });
  if (!go) log.warn('Aborted.');
  return Boolean(go);
}
