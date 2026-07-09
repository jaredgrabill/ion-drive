/**
 * `ion-drive add <ref>` — resolves a block (and its dependencies) and installs
 * them into the configured server.
 *
 * The shadcn `add` analog, spec-03 + spec-04 edition: parse the ref (`crm`,
 * `crm@^0.2.0`, `@acme/billing@1.x`, a block.json URL, or a local path),
 * resolve the dependency closure across configured registries, then run the
 * **verify phase** — every registry artifact is fetched as raw bytes and its
 * sha256 checked against the registry-declared digest *before* the plan is
 * shown, anything is vendored, or the server is called. A digest mismatch
 * aborts the whole command with no `--force` override (spec-04 AC1).
 * Attestation bundles, when present, are verified through the sigstore seam
 * and produce the `official`/`verified`/`community` badge on each plan line.
 *
 * The resolve+verify pipeline itself lives in `registry/preview.ts`
 * ({@link buildVerifiedPlan}) and is **shared verbatim** with the registry
 * MCP's `preview_install` tool (spec-08 AC4) — this module owns only the UI:
 * spinners, plan rendering, confirmation, vendoring, and the install loop.
 *
 * The local `ion.config.json` records what was installed — name, version, the
 * **computed** digest, source, sourceUrl — and the server install carries a
 * `source` envelope so the `_ion_blocks` ledger keeps provenance.
 */

import { createHash } from 'node:crypto';
import ora from 'ora';
import prompts from 'prompts';
import { ApiError, type InstallReport, type InstallSource, IonApiClient } from '../api-client.js';
import {
  ConfigError,
  type IonProjectConfig,
  readConfig,
  recordInstalled,
  writeConfig,
} from '../config.js';
import { BarrelError, VendorError, addToBarrel, vendorBlockCode } from '../project.js';
import {
  type VerifiedItem,
  type VerifiedPlan,
  buildVerifiedPlan,
  gatherServerState,
} from '../registry/preview.js';
import { RefError, parseRef } from '../registry/ref.js';
import { type Manifest, RegistryError } from '../registry/registry-client.js';
import { type InstallPlan, ResolveError } from '../registry/resolver.js';
import { IntegrityError, tierBadge } from '../registry/verify.js';
import { box, c, gradient, log, orbitSpinner, sym } from '../ui.js';
import { warnOnVersionSkew } from '../version-check.js';

// The verify phase moved to registry/preview.ts (spec-08) — re-exported here
// so existing import sites (update-shared, block-test, tests) stay stable.
export {
  fetchAndVerifyPlan,
  type VerifiedItem,
  type VerifyPhaseDeps,
} from '../registry/preview.js';

export interface AddOptions {
  yes?: boolean;
  dryRun?: boolean;
  /**
   * One flag, three effects (C10): the server force-reinstalls, the resolver
   * proceeds through installed-version conflicts, and an already-installed
   * root is planned as a reinstall instead of "nothing to do". It never
   * touches the digest check — that has no override by design.
   */
  force?: boolean;
  /** Commander's `--no-cache` negation: `cache === false` bypasses cache reads. */
  cache?: boolean;
  /** Print each block's vendored file listing before the confirm prompt. */
  showCode?: boolean;
  /**
   * Commander's `--no-verify-provenance` negation: `verifyProvenance ===
   * false` skips attestation checks (the digest check is never skippable).
   */
  verifyProvenance?: boolean;
}

export async function addCommand(target: string, options: AddOptions): Promise<void> {
  const config = readConfig();
  const client = new IonApiClient(config.serverUrl, config.apiKey);

  const result = await resolveAndVerify(client, config, target, options);
  if (!result) return;
  const { plan, verified } = result;
  if (plan.items.length === 0) {
    log.info(`${c.bold(target)} is already installed. Nothing to do.`);
    return;
  }

  renderPlan(target, config.serverUrl, plan, verified, options);
  if (options.showCode) renderCodeListing(verified);

  if (!(await confirmInstall(verified.length, options))) return;

  await runInstalls(client, config, verified, options);
}

/**
 * The command-layer wrapper around the shared pipeline: gathers server state
 * (hard failure when unreachable — `add` needs the server anyway), warns on
 * CLI↔server version skew, then delegates to {@link buildVerifiedPlan}.
 * Returns null after friendly-logging any known failure.
 */
async function resolveAndVerify(
  client: IonApiClient,
  config: IonProjectConfig,
  target: string,
  options: AddOptions,
): Promise<VerifiedPlan | null> {
  try {
    parseRef(target); // ref problems first — before any network call
    const serverState = await gatherServerState(client, config);
    if (serverState.serverCoreVersion) warnOnVersionSkew(serverState.serverCoreVersion);
    return await buildVerifiedPlan(target, config, {
      serverState,
      force: options.force,
      noCache: options.cache === false,
      verifyProvenance: options.verifyProvenance !== false,
    });
  } catch (err) {
    return failFriendly(err);
  }
}

/** Shared friendly-failure handler: logs known error types, rethrows the rest. */
function failFriendly(err: unknown): null {
  if (
    err instanceof ApiError ||
    err instanceof RegistryError ||
    err instanceof ResolveError ||
    err instanceof RefError ||
    err instanceof ConfigError ||
    err instanceof IntegrityError
  ) {
    log.error(err.message);
    process.exitCode = 1;
    return null;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Plan rendering + confirmation
// ---------------------------------------------------------------------------

/** Object names a manifest declares (for local/URL plan lines). */
function objectNames(manifest: Manifest): string[] {
  const objects = manifest.objects as { name?: string }[] | undefined;
  return (objects ?? []).map((o) => o.name ?? '?');
}

/** Colorizes the plain-text trust badge per tier. */
function paintedBadge(v: VerifiedItem): string {
  const badge = tierBadge(v.tier, v.item.repository);
  if (v.tier === 'official') return c.success(badge);
  if (v.tier === 'verified') return c.cyan(badge);
  return c.meteor(badge);
}

/** One plan line: `1. crm@0.2.0 · @ion · ◆ official`; object list for local/URL. */
function planLine(v: VerifiedItem, index: number): string {
  const item = v.item;
  const tag = item.isDependency ? c.plasma(' (dependency)') : '';
  const label = `${c.meteor(`${index + 1}.`)} ${c.bold(item.name)}${c.meteor(`@${item.version}`)}${tag}`;
  if (item.manifest) {
    const objects = objectNames(item.manifest);
    return `${label} ${c.meteor(`(${item.source})`)} ${paintedBadge(v)}  ${c.dim(`→ ${objects.join(', ') || '(no objects)'}`)}`;
  }
  return `${label} ${c.meteor('·')} ${c.cyan(item.source)} ${c.meteor('·')} ${paintedBadge(v)}`;
}

/** Prints the install plan preview box (badges + verify-phase warnings). */
function renderPlan(
  target: string,
  serverUrl: string,
  plan: InstallPlan,
  verified: VerifiedItem[],
  options: AddOptions,
): void {
  const planLines: string[] = [];
  verified.forEach((v, i) => {
    planLines.push(planLine(v, i));
    for (const w of [...v.item.warnings, ...v.warnings]) {
      planLines.push(`   ${sym.warn} ${c.warn(w)}`);
    }
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

/** `--show-code`: each block's vendored files as path · bytes · sha256 rows. */
function renderCodeListing(verified: VerifiedItem[]): void {
  for (const v of verified) {
    const files = v.manifest.code ?? [];
    if (files.length === 0) continue;
    log.raw();
    log.info(`${c.bold(v.item.name)} vendors ${files.length} file(s) into blocks/${v.item.name}/:`);
    for (const file of files) {
      const bytes = Buffer.byteLength(file.contents, 'utf8');
      const sha = createHash('sha256').update(file.contents, 'utf8').digest('hex');
      log.raw(
        `  ${sym.dot} ${c.cyan(file.path)} ${c.meteor('·')} ${bytes} B ${c.meteor('·')} ${c.dim(`sha256:${sha}`)}`,
      );
    }
  }
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

// ---------------------------------------------------------------------------
// Install phase
// ---------------------------------------------------------------------------

/**
 * The client-asserted provenance envelope stored in the server ledger.
 * Exported for `ion-drive update`, which installs through the same envelope.
 */
export function sourceFor(v: VerifiedItem): InstallSource {
  return {
    registry: v.item.registry,
    url: v.item.sourceUrl,
    digest: v.computedDigest,
    attested: v.attestationStatus === 'ok',
    publisher: v.attestedBy?.repository ? `github.com/${v.attestedBy.repository}` : undefined,
    tier: v.tier,
  };
}

/** `sha256:ab12ef…` — a digest shortened for summary lines. */
function shortDigest(digest: string): string {
  return `${digest.slice(0, 'sha256:'.length + 12)}…`;
}

/** `crm 0.2.0 · ◆ official · sha256:ab12…  (attested: owner/repo@a1b2c3)`. */
function summaryLine(v: VerifiedItem): string {
  const attested = v.attestedBy
    ? c.dim(
        `  (attested: ${v.attestedBy.repository}${v.attestedBy.commit ? `@${v.attestedBy.commit.slice(0, 7)}` : ''})`,
      )
    : '';
  return `${c.bold(v.item.name)} ${c.meteor(v.item.version)} ${c.meteor('·')} ${paintedBadge(v)} ${c.meteor('·')} ${c.dim(shortDigest(v.computedDigest))}${attested}`;
}

/** Installs each verified item in order, updating the local config + summary. */
async function runInstalls(
  client: IonApiClient,
  config: IonProjectConfig,
  verified: VerifiedItem[],
  options: AddOptions,
): Promise<void> {
  log.raw();
  let updatedConfig = config;
  for (const v of verified) {
    if (!options.dryRun && !(await vendorStep(client, v.manifest))) {
      process.exitCode = 1;
      return;
    }
    const report = await installOne(client, v, options);
    if (!report) {
      process.exitCode = 1;
      return;
    }
    if (!options.dryRun) {
      updatedConfig = recordInstalled(updatedConfig, {
        name: v.item.name,
        version: v.item.version,
        digest: v.computedDigest,
        source: v.item.source,
        sourceUrl: v.item.sourceUrl,
      });
    }
  }

  if (!options.dryRun) writeConfig(updatedConfig);

  log.raw();
  for (const v of verified) log.raw(`  ${sym.check} ${summaryLine(v)}`);
  log.raw();
  log.success(
    gradient(
      options.dryRun
        ? `Dry run complete — ${verified.length} block(s) would be installed. ${sym.sparkle}`
        : `Liftoff! ${verified.length} block(s) installed. ${sym.rocket}`,
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
  let result: ReturnType<typeof vendorBlockCode>;
  try {
    result = vendorBlockCode(name, files);
  } catch (err) {
    if (err instanceof VendorError) {
      log.error(err.message);
      return false;
    }
    throw err;
  }
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

/**
 * Polls the server until the block's handlers are registered (dev-server
 * reload). Exported for `ion-drive update`, which re-vendors code before its
 * real install and must wait for the same reload (spec-07).
 */
export async function waitForHandlers(client: IonApiClient, manifest: Manifest): Promise<boolean> {
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

/** Installs one verified item with a spinner, printing its report. Null on failure. */
async function installOne(
  client: IonApiClient,
  v: VerifiedItem,
  options: AddOptions,
): Promise<InstallReport | null> {
  const name = String(v.manifest.name);
  const spinner = ora({
    text: `${options.dryRun ? 'Previewing' : 'Installing'} ${c.bold(name)}…`,
    spinner: orbitSpinner,
  }).start();

  try {
    const report = await client.install(v.manifest, {
      dryRun: options.dryRun,
      force: options.force,
      source: sourceFor(v),
    });
    spinner.stopAndPersist({
      symbol: sym.check,
      text: `${c.bold(name)} ${c.meteor(`v${report.version}`)}`,
    });
    printReport(report);
    return report;
  } catch (err) {
    spinner.stopAndPersist({ symbol: sym.cross, text: c.danger(name) });
    if (err instanceof ApiError) {
      log.error(err.message);
      for (const w of err.warnings) log.warn(w);
    } else {
      log.error((err as Error).message);
    }
    return null;
  }
}

/** Prints the notable lines of an install report (indented). Shared with `update`. */
export function printReport(report: InstallReport): void {
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
