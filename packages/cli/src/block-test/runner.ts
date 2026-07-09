/**
 * `ion-drive block test [dir]` — the install-and-run test loop for a block
 * (spec-06 §1). Two modes:
 *
 *  - **Ephemeral (default)**: create a scratch database
 *    (`ion_blocktest_<rand>` on `--database-url`/`ION_DATABASE_URL`), assemble
 *    a throwaway temp project (vendored code + barrel + junction-linked
 *    `@ion-drive/core`/`tsx`/`zod`), boot a real server via a generated
 *    composition root under tsx, then install → assert → uninstall against
 *    it. Teardown drops the database and temp dir unless `--keep`.
 *  - **`--server <url>`**: run the same install/assert/uninstall loop against
 *    an existing server (the CI-service-container mode). Refuses a server
 *    that reports existing user objects unless `--force`, and finally-guards
 *    uninstalls so a passing or failing run leaves zero residue.
 *
 * Dependencies resolve through the configured registries (with the spec-04
 * digest gate) by default, or entirely offline from a sibling directory of
 * co-developed blocks via `--deps-from <dir>` ({@link resolveLocalDeps}).
 *
 * Order of operations (handlers register at boot, so no polling):
 * parse manifest → resolve deps → vendor → boot → install deps → install
 * block (dry-run, then real) → assertions → block-local tests → uninstall.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import semver from 'semver';
import { ApiError, type InstallReport, IonApiClient } from '../api-client.js';
import { fetchAndVerifyPlan } from '../commands/add.js';
import { structuralManifestChecks } from '../commands/block.js';
import { ConfigError, type IonProjectConfig, readConfig } from '../config.js';
import {
  BarrelError,
  EMPTY_BARREL,
  VendorError,
  addToBarrel,
  vendorBlockCode,
} from '../project.js';
import { loadCoreValidator } from '../registry/core-loader.js';
import { RefError, splitBlockRef } from '../registry/ref.js';
import {
  type Manifest,
  RegistryError,
  dependencyRecordOf,
  fetchBlock,
  fetchIndex,
  fetchManifestFromUrl,
  readLocalBlock,
} from '../registry/registry-client.js';
import { ResolveError, type ResolverIO, resolvePlan } from '../registry/resolver.js';
import { IntegrityError, computeDigest, packBytes } from '../registry/verify.js';
import { c, log, sym } from '../ui.js';
import {
  type CheckResult,
  checkActions,
  checkObjects,
  checkUninstall,
  evaluateInstallReport,
  runBlockLocalTests,
} from './assertions.js';
import {
  BLOCK_TEST_CORE_MESSAGE,
  DEFAULT_DATABASE_URL,
  type EphemeralServer,
  EphemeralServerError,
  createScratchDb,
  dropScratchDb,
  linkDependency,
  removeDirWithRetry,
  resolvePackageDir,
  startEphemeralServer,
} from './ephemeral-server.js';
import { FixturesError, readFixtures } from './fixtures.js';

export interface BlockTestOptions {
  /** Test against this running server instead of booting one. */
  server?: string;
  /** Ephemeral-mode Postgres connection point (server-owner DSN). */
  databaseUrl?: string;
  /** Resolve dependencies from local sibling directories (offline). */
  depsFrom?: string;
  /** Keep the temp project + scratch database for debugging. */
  keep?: boolean;
  /** Proceed against a --server instance that has user objects. */
  force?: boolean;
  json?: boolean;
  /** Commander's `--no-cache` negation. */
  cache?: boolean;
}

/** One resolved dependency to install before the block under test. */
interface ResolvedDep {
  name: string;
  version: string;
  manifest: Manifest;
}

// ---------------------------------------------------------------------------
// --deps-from: the offline local closure walker (spec-06 D4)
// ---------------------------------------------------------------------------

/**
 * Resolves the block's dependency closure from local sibling directories
 * (`<depsFrom>/<name>/block.json` — the blocks-repo layout). Deps-first
 * order, cycle-guarded, range-checked (`semver.satisfies` is a hard error),
 * zero network. Missing directories get an actionable error.
 * @throws {ResolveError}
 */
export function resolveLocalDeps(rootManifest: Manifest, depsFrom: string): ResolvedDep[] {
  const state: LocalWalkState = {
    base: resolve(depsFrom),
    ordered: [],
    done: new Map(),
    visiting: new Set(),
    rootName: String(rootManifest.name),
    rootVersion: String(rootManifest.version ?? '0.1.0'),
  };
  state.visiting.add(state.rootName);
  visitManifestDeps(state, rootManifest, [state.rootName]);
  return state.ordered;
}

/** The local walker's shared state (deps-first order accumulates in `ordered`). */
interface LocalWalkState {
  base: string;
  ordered: ResolvedDep[];
  /** name → resolved version. */
  done: Map<string, string>;
  visiting: Set<string>;
  rootName: string;
  rootVersion: string;
}

/** Walks one manifest's dependency record. */
function visitManifestDeps(state: LocalWalkState, manifest: Manifest, trail: string[]): void {
  for (const [depRef, range] of Object.entries(dependencyRecordOf(manifest))) {
    const name = splitBlockRef(depRef)?.name;
    if (!name) {
      throw new ResolveError(
        `"${manifest.name}" declares an invalid dependency ref "${depRef}" (expected "name" or "@ns/name").`,
      );
    }
    visitLocalDep(state, manifest, name, range, trail);
  }
}

/** Resolves one dependency: already-known version check, cycle guard, recurse. */
function visitLocalDep(
  state: LocalWalkState,
  requiredBy: Manifest,
  name: string,
  range: string,
  trail: string[],
): void {
  const known = name === state.rootName ? state.rootVersion : state.done.get(name);
  if (known !== undefined) {
    assertSatisfies(name, known, range, String(requiredBy.name));
    return;
  }
  if (state.visiting.has(name)) {
    throw new ResolveError(`Circular dependency: ${[...trail, name].join(' → ')}`);
  }
  const dep = readLocalDep(state.base, requiredBy, name);
  const version = String(dep.version ?? '0.1.0');
  assertSatisfies(name, version, range, String(requiredBy.name));
  state.visiting.add(name);
  visitManifestDeps(state, dep, [...trail, name]);
  state.visiting.delete(name);
  state.done.set(name, version);
  state.ordered.push({ name, version, manifest: dep });
}

/** Reads `<base>/<name>/block.json`, with the actionable missing-dir error. */
function readLocalDep(base: string, requiredBy: Manifest, name: string): Manifest {
  const dir = join(base, name);
  try {
    return readLocalBlock(dir);
  } catch (err) {
    throw new ResolveError(
      `"${requiredBy.name}" depends on "${name}", but ${join(dir, 'block.json')} is not readable (${(err as Error).message}). --deps-from expects one directory per block name under ${base}.`,
    );
  }
}

function assertSatisfies(name: string, version: string, range: string, requiredBy: string): void {
  if (!semver.satisfies(version, range)) {
    throw new ResolveError(
      `"${requiredBy}" needs ${name}@${range} but the local copy is ${version} — bump or align the versions before testing.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registry-backed dependency resolution (the default — digest gate applies)
// ---------------------------------------------------------------------------

async function resolveRegistryDeps(
  root: string,
  rootName: string,
  config: IonProjectConfig,
  installed: Map<string, string>,
  options: BlockTestOptions,
): Promise<ResolvedDep[]> {
  const noCache = options.cache === false;
  const io: ResolverIO = {
    fetchIndex: (reg) => fetchIndex(reg, { noCache }),
    fetchBlock: (reg, name) => fetchBlock(reg, name, { noCache }),
    getLocalOrUrlManifest: async (ref) => {
      if (ref.kind === 'url') return fetchManifestFromUrl(ref.url);
      const manifest = readLocalBlock(ref.path);
      return { manifest, digest: computeDigest(packBytes(manifest)) };
    },
  };
  const plan = await resolvePlan(
    { kind: 'local', path: root },
    { config, installed, recordedBlocks: [], force: true, io },
  );
  const verified = await fetchAndVerifyPlan(plan.items, config, { verifyProvenance: true });
  return verified
    .filter((v) => v.item.name !== rootName)
    .map((v) => ({ name: v.item.name, version: v.item.version, manifest: v.manifest }));
}

// ---------------------------------------------------------------------------
// The run report
// ---------------------------------------------------------------------------

interface RunReport {
  block: string;
  version: string;
  mode: 'ephemeral' | 'server';
  checks: CheckResult[];
  ok: boolean;
}

/** Prints one checklist line as a check completes (suppressed under --json). */
function renderCheck(result: CheckResult, json: boolean | undefined): void {
  if (json) return;
  const detail = result.detail ? c.dim(` — ${result.detail}`) : '';
  if (result.status === 'pass') log.raw(`  ${sym.check} ${result.name}${detail}`);
  else if (result.status === 'skip') log.raw(`  ${sym.dot} ${c.meteor(result.name)}${detail}`);
  else log.raw(`  ${sym.cross} ${c.danger(result.name)}${detail}`);
}

function finishRun(report: RunReport, options: BlockTestOptions): void {
  report.ok = report.checks.every((check) => check.status !== 'fail');
  if (options.json) {
    const passed = report.checks.filter((check) => check.status === 'pass').length;
    const failed = report.checks.filter((check) => check.status === 'fail').length;
    console.log(JSON.stringify({ ...report, passed, failed }, null, 2));
  } else {
    const passed = report.checks.filter((check) => check.status !== 'fail').length;
    log.raw();
    if (report.ok) {
      log.success(
        `${c.bold(report.block)}@${report.version} — ${passed}/${report.checks.length} checks passed ${sym.sparkle}`,
      );
    } else {
      log.error(`${report.block}@${report.version} — a block test check failed (see above).`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

/** Known error types get a friendly line + exit 1; everything else rethrows. */
function failFriendly(err: unknown, options: BlockTestOptions): void {
  if (
    err instanceof ApiError ||
    err instanceof RegistryError ||
    err instanceof ResolveError ||
    err instanceof RefError ||
    err instanceof ConfigError ||
    err instanceof IntegrityError ||
    err instanceof EphemeralServerError ||
    err instanceof FixturesError ||
    err instanceof VendorError ||
    err instanceof BarrelError
  ) {
    if (options.json) console.log(JSON.stringify({ error: err.message }, null, 2));
    else log.error(err.message);
    process.exitCode = 1;
    return;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function blockTestCommand(dir = '.', options: BlockTestOptions = {}): Promise<void> {
  try {
    await runBlockTest(resolve(dir), options);
  } catch (err) {
    failFriendly(err, options);
  }
}

async function runBlockTest(root: string, options: BlockTestOptions): Promise<void> {
  const manifest = readLocalBlock(root); // throws RegistryError with the path
  const report: RunReport = {
    block: String(manifest.name),
    version: String(manifest.version ?? '0.1.0'),
    mode: options.server ? 'server' : 'ephemeral',
    checks: [],
    ok: false,
  };
  if (!options.json) {
    log.raw();
    log.step(
      `${sym.satellite} block test ${c.bold(report.block)}${c.meteor(`@${report.version}`)} ${c.meteor(`(${report.mode})`)}`,
    );
  }

  // Check 1 — manifest parses (fail fast: nothing else runs on a bad manifest).
  const manifestCheck = await checkManifest(manifest);
  report.checks.push(manifestCheck);
  renderCheck(manifestCheck, options.json);
  if (manifestCheck.status === 'fail') {
    finishRun(report, options);
    return;
  }

  const fixtures = readFixtures(root); // throws FixturesError on a broken file

  if (options.server) await runServerMode(root, manifest, fixtures, report, options);
  else await runEphemeralMode(root, manifest, fixtures, report, options);

  finishRun(report, options);
}

/** Check 1: core's strict parser when resolvable + the structural checks. */
async function checkManifest(manifest: Manifest): Promise<CheckResult> {
  const problems: string[] = [];
  let detail = '';
  const core = await loadCoreValidator();
  if (core) {
    try {
      core.parseManifest(manifest);
    } catch (err) {
      problems.push((err as Error).message);
    }
  } else {
    detail = 'structural checks only (@ion-drive/core not resolvable)';
  }
  problems.push(...structuralManifestChecks(manifest));
  if (problems.length > 0) {
    return { name: 'manifest parses', status: 'fail', detail: problems.join('; ') };
  }
  return { name: 'manifest parses', status: 'pass', ...(detail ? { detail } : {}) };
}

/** Resolves the dependency closure for either mode. */
async function resolveDeps(
  root: string,
  manifest: Manifest,
  installed: Map<string, string>,
  options: BlockTestOptions,
): Promise<ResolvedDep[]> {
  if (options.depsFrom) {
    return resolveLocalDeps(manifest, options.depsFrom).filter((dep) => !installed.has(dep.name));
  }
  if (Object.keys(dependencyRecordOf(manifest)).length === 0) return [];
  return resolveRegistryDeps(root, String(manifest.name), readConfig(), installed, options);
}

// ---------------------------------------------------------------------------
// Ephemeral mode
// ---------------------------------------------------------------------------

async function runEphemeralMode(
  root: string,
  manifest: Manifest,
  fixtures: ReturnType<typeof readFixtures>,
  report: RunReport,
  options: BlockTestOptions,
): Promise<void> {
  // Resolution runs BEFORE anything is created (nothing to tear down on error).
  const deps = await resolveDeps(root, manifest, new Map(), options);
  const links = resolveLinkedPackages();

  const adminUrl = options.databaseUrl ?? process.env.ION_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const scratch = await createScratchDb(adminUrl);
  const projectDir = mkdtempSync(join(tmpdir(), 'ion-blocktest-'));
  let server: EphemeralServer | undefined;

  try {
    assembleTempProject(projectDir, links, [...deps, { name: String(manifest.name), manifest }]);

    if (!options.json) log.dim(`  booting an ephemeral server (db ${scratch.name})…`);
    server = await startEphemeralServer({ projectDir, databaseUrl: scratch.url });

    const client = new IonApiClient(server.url, server.apiKey);
    await runSuite({
      client,
      blockDir: root,
      manifest,
      fixtures,
      deps,
      report,
      options,
      tsxDir: links.tsxDir,
      serverUrl: server.url,
      apiKey: server.apiKey,
      cleanupDeps: false, // the scratch database is dropped whole
    });
  } catch (err) {
    if (server && !options.json) process.stderr.write(`${server.logs()}\n`);
    throw err;
  } finally {
    if (server) await server.stop();
    await teardownEphemeral({ server, options, scratch, adminUrl, projectDir });
  }
}

/** The packages junction-linked into the temp project (spec-06 D1). */
interface LinkedPackages {
  coreDir: string;
  tsxDir: string;
  zodDir: string | null;
}

/** Resolves core/tsx/zod project-first — hard, actionable errors up front. */
function resolveLinkedPackages(): LinkedPackages {
  const coreDir = resolvePackageDir('@ion-drive/core');
  if (!coreDir) throw new EphemeralServerError(BLOCK_TEST_CORE_MESSAGE);
  const tsxDir = resolvePackageDir('tsx', [coreDir]);
  if (!tsxDir) {
    throw new EphemeralServerError(
      'Could not resolve tsx — block test runs its ephemeral server under tsx. Reinstall @ion-drive/cli (tsx is one of its dependencies).',
    );
  }
  // zod is core's dependency, not the CLI's — vendored block code imports it.
  return { coreDir, tsxDir, zodDir: resolvePackageDir('zod', [coreDir]) };
}

/** Temp project assembly: ESM manifest, barrel, junction links, vendored code. */
function assembleTempProject(
  projectDir: string,
  links: LinkedPackages,
  blocks: { name: string; manifest: Manifest }[],
): void {
  writeFileSync(
    join(projectDir, 'package.json'),
    `${JSON.stringify({ name: 'ion-block-test', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  mkdirSync(join(projectDir, 'blocks'), { recursive: true });
  writeFileSync(join(projectDir, 'blocks', 'index.ts'), EMPTY_BARREL, 'utf8');
  linkDependency(projectDir, '@ion-drive/core', links.coreDir);
  linkDependency(projectDir, 'tsx', links.tsxDir);
  if (links.zodDir) linkDependency(projectDir, 'zod', links.zodDir);
  for (const block of blocks) {
    const files = block.manifest.code ?? [];
    if (files.length === 0) continue;
    vendorBlockCode(block.name, files, projectDir);
    addToBarrel(block.name, projectDir);
  }
}

/** Teardown: drop DB + temp dir, or keep both (replaying logs) under --keep. */
async function teardownEphemeral(input: {
  server: EphemeralServer | undefined;
  options: BlockTestOptions;
  scratch: { name: string; url: string };
  adminUrl: string;
  projectDir: string;
}): Promise<void> {
  const { server, options, scratch, adminUrl, projectDir } = input;
  if (options.keep) {
    if (server) process.stderr.write(`${server.logs()}\n`);
    log.info(`--keep: scratch database ${c.cyan(scratch.url)}`);
    log.info(`--keep: temp project ${c.cyan(projectDir)}`);
    return;
  }
  removeDirWithRetry(projectDir);
  await dropScratchDb(adminUrl, scratch.name).catch((err: Error) => {
    log.warn(`Could not drop scratch database ${scratch.name}: ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// --server mode
// ---------------------------------------------------------------------------

async function runServerMode(
  root: string,
  manifest: Manifest,
  fixtures: ReturnType<typeof readFixtures>,
  report: RunReport,
  options: BlockTestOptions,
): Promise<void> {
  const serverUrl = options.server as string;
  const config = readConfig();
  const client = new IonApiClient(serverUrl, config.apiKey);

  const health = await client.health();
  if (health.objectCount > 0 && !options.force) {
    throw new ApiError(
      `Refusing to test against ${serverUrl} — it reports ${health.objectCount} existing user object(s). block test installs and uninstalls real schema and data; point it at a disposable server, or pass --force if you accept the risk.`,
      0,
    );
  }

  const installed = new Map(
    (await client.listInstalled())
      .filter((b) => b.status === 'installed')
      .map((b) => [b.name, b.version] as const),
  );
  const deps = await resolveDeps(root, manifest, installed, options);
  const tsxDir = resolvePackageDir('tsx');

  await runSuite({
    client,
    blockDir: root,
    manifest,
    fixtures,
    deps,
    report,
    options,
    tsxDir,
    serverUrl,
    apiKey: config.apiKey ?? '',
    cleanupDeps: true, // zero residue on a shared server
  });
}

// ---------------------------------------------------------------------------
// The shared install → assert → uninstall suite
// ---------------------------------------------------------------------------

interface SuiteContext {
  client: IonApiClient;
  blockDir: string;
  manifest: Manifest;
  fixtures: ReturnType<typeof readFixtures>;
  deps: ResolvedDep[];
  report: RunReport;
  options: BlockTestOptions;
  tsxDir: string | null;
  serverUrl: string;
  apiKey: string;
  /** Uninstall the deps this run installed (server mode's zero-residue rule). */
  cleanupDeps: boolean;
}

async function runSuite(ctx: SuiteContext): Promise<void> {
  const push = (result: CheckResult) => {
    ctx.report.checks.push(result);
    renderCheck(result, ctx.options.json);
    return result.status !== 'fail';
  };
  const installedDeps: ResolvedDep[] = [];
  const state = { rootInstalled: false };

  try {
    await runInstallAndAsserts(ctx, push, installedDeps, state);
  } finally {
    // Check 5 — uninstall + doctor. Finally-guarded: even a failing run must
    // leave zero residue (live-smoke rule: cleanup failures are failures too).
    if (state.rootInstalled) {
      push(await checkUninstall(ctx.client, ctx.manifest));
    }
    if (ctx.cleanupDeps && installedDeps.length > 0) {
      const problems = await uninstallDeps(ctx.client, installedDeps);
      if (problems.length > 0) {
        push({ name: 'dependency cleanup', status: 'fail', detail: problems.join('; ') });
      }
    }
  }
}

type PushCheck = (result: CheckResult) => boolean;

/** Checks 2–4 + 6: dependency install, root install + report, reality, tests. */
async function runInstallAndAsserts(
  ctx: SuiteContext,
  push: PushCheck,
  installedDeps: ResolvedDep[],
  state: { rootInstalled: boolean },
): Promise<void> {
  const { client, manifest } = ctx;

  // Check 2a — dependencies install.
  if (ctx.deps.length === 0) {
    push({ name: 'dependencies', status: 'skip', detail: 'none' });
  } else if (!push(await installDeps(client, ctx.deps, installedDeps))) {
    return;
  }

  // Check 2b — the block installs (dry-run first, then real) with a clean report.
  const install = await installRoot(client, manifest);
  if (typeof install === 'string') {
    push({ name: 'install report clean', status: 'fail', detail: install });
    return;
  }
  state.rootInstalled = true;
  if (!push(reportCheck(ctx, install))) return;

  // Checks 3–4 — registry reality + action reachability.
  push(await checkObjects(client, manifest, ctx.fixtures));
  push(await checkActions(client, manifest, ctx.fixtures));

  // Check 6 — block-local tests (while the block is still installed).
  push(await runLocalTests(ctx));
}

/** Evaluates the install report, surfacing its warnings as notices. */
function reportCheck(ctx: SuiteContext, install: InstallReport): CheckResult {
  const evaluation = evaluateInstallReport(ctx.manifest, install);
  if (!ctx.options.json) {
    for (const notice of evaluation.notices) log.raw(`    ${sym.warn} ${c.warn(notice)}`);
  }
  return {
    name: 'install report clean',
    status: evaluation.ok ? 'pass' : 'fail',
    detail: evaluation.ok ? `v${install.version}` : evaluation.problems.join('; '),
  };
}

/** Installs the resolved deps in order, recording what actually installed. */
async function installDeps(
  client: IonApiClient,
  deps: ResolvedDep[],
  installedDeps: ResolvedDep[],
): Promise<CheckResult> {
  for (const dep of deps) {
    try {
      await client.install(dep.manifest, {});
      installedDeps.push(dep);
    } catch (err) {
      const warnings = err instanceof ApiError ? err.warnings : [];
      return {
        name: 'dependencies',
        status: 'fail',
        detail: `installing ${dep.name}@${dep.version}: ${(err as Error).message}${
          warnings.length > 0 ? ` (${warnings.join('; ')})` : ''
        }`,
      };
    }
  }
  return {
    name: 'dependencies',
    status: 'pass',
    detail: deps.map((dep) => `${dep.name}@${dep.version}`).join(', '),
  };
}

/** Dry-run then real install of the block under test; error text on failure. */
async function installRoot(
  client: IonApiClient,
  manifest: Manifest,
): Promise<InstallReport | string> {
  for (const dryRun of [true, false]) {
    try {
      const result = await client.install(manifest, { dryRun, force: true });
      if (!dryRun) return result;
    } catch (err) {
      const warnings = err instanceof ApiError ? err.warnings : [];
      return `${dryRun ? 'preview' : 'install'} failed: ${(err as Error).message}${
        warnings.length > 0 ? ` (${warnings.join('; ')})` : ''
      }`;
    }
  }
  return 'install did not produce a report'; // unreachable
}

/** Check 6 wrapper — needs the tsx CLI entry to run `tsx --test`. */
async function runLocalTests(ctx: SuiteContext): Promise<CheckResult> {
  const testsDir = join(ctx.blockDir, 'test');
  if (!existsSync(testsDir)) {
    return { name: 'block-local tests', status: 'skip', detail: 'no test/ directory' };
  }
  if (!ctx.tsxDir) {
    return {
      name: 'block-local tests',
      status: 'fail',
      detail: 'test/ exists but tsx is not resolvable — reinstall @ion-drive/cli',
    };
  }
  const tsxCliJs = join(ctx.tsxDir, 'dist', 'cli.mjs');
  return runBlockLocalTests(
    ctx.blockDir,
    tsxCliJs,
    { serverUrl: ctx.serverUrl, apiKey: ctx.apiKey },
    // --json owns stdout; the test runner's output goes to stderr instead.
    ctx.options.json ? 'stderr' : 'inherit',
  );
}

/** Reverse-order dep uninstall (dependents first); returns cleanup problems. */
async function uninstallDeps(
  client: IonApiClient,
  installedDeps: ResolvedDep[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const dep of [...installedDeps].reverse()) {
    try {
      await client.uninstall(dep.name, { dropData: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) continue; // already gone
      problems.push(`${dep.name}: ${(err as Error).message}`);
    }
  }
  return problems;
}
