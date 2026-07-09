/**
 * `ion-drive block <new|validate|pack|publish>` — the block-authoring
 * toolchain (Phase 14 Tier 4, ADR-018 amendment; `publish` from spec-05).
 *
 * Blocks live outside the platform monorepo (official ones as directories of
 * the `jaredgrabill/ion-drive-blocks` repo; third-party ones anywhere), each authored in the
 * same simple layout:
 *
 *   block.json   — the manifest (source of truth; no embedded code)
 *   code/        — vendored TypeScript files, when the block ships logic
 *   dist/<version>/block.json — the immutable distributable artifact (`pack`
 *                     embeds code/ here); registry version entries point at it
 *
 * `new` scaffolds that layout; `validate` runs the platform's Zod parser over
 * the manifest (via an optional dynamic import of core — present in framework
 * projects and the monorepo) plus structural code checks; `pack` emits the
 * artifact; `publish` orchestrates the git-registry publish loop (clone →
 * copy → `registry build` → PR or push). CI in a block repo is `validate` +
 * `pack` + drift check.
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import semver from 'semver';
import { buildRegistry, realBuildFs } from '../registry/build.js';
import { CORE_REQUIRED_MESSAGE, loadCoreValidator } from '../registry/core-loader.js';
import { type Manifest, readLocalBlock } from '../registry/registry-client.js';
import { computeDigest, packBytes } from '../registry/verify.js';
import {
  BLOCK_GITATTRIBUTES,
  BLOCK_GITIGNORE,
  FIXTURES_SKELETON,
  blockCi,
  blockPublishWorkflow,
  blockReadme,
  codeIndexSkeleton,
  manifestSkeleton,
  smokeTestSkeleton,
} from '../templates/block-scaffold.js';
import { c, log, sym } from '../ui.js';

// ---------------------------------------------------------------------------
// block new (templates live in ../templates/block-scaffold.ts — spec-06 §2)
// ---------------------------------------------------------------------------

export async function blockNewCommand(name: string): Promise<void> {
  const safe = name.replace(/^block-/, '');
  if (!/^[a-z][a-z0-9_-]*$/.test(safe)) {
    log.error(`"${safe}" is not a valid block name (lowercase kebab/snake case).`);
    process.exitCode = 1;
    return;
  }
  const dir = resolve(`block-${safe}`);
  if (existsSync(join(dir, 'block.json'))) {
    log.error(`${dir} already contains a block.json — refusing to scaffold over it.`);
    process.exitCode = 1;
    return;
  }

  const files: [string, string][] = [
    ['block.json', manifestSkeleton(safe)],
    ['code/index.ts', codeIndexSkeleton(safe)],
    ['test/fixtures.json', FIXTURES_SKELETON],
    ['test/smoke.test.ts', smokeTestSkeleton(safe)],
    ['README.md', blockReadme(safe)],
    ['.github/workflows/ci.yml', blockCi()],
    ['.github/workflows/publish.yml', blockPublishWorkflow(safe)],
    ['.gitignore', BLOCK_GITIGNORE],
    ['.gitattributes', BLOCK_GITATTRIBUTES],
  ];
  for (const [path, contents] of files) {
    const target = join(dir, path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
    log.raw(`  ${sym.check} ${c.cyan(`block-${safe}/${path}`)}`);
  }
  log.raw();
  log.success(
    `Block repo scaffolded. Next: edit block.json, then ${c.star('ion-drive block validate')}`,
  );
}

// ---------------------------------------------------------------------------
// block validate
// ---------------------------------------------------------------------------

export async function blockValidateCommand(dir = '.'): Promise<void> {
  const root = resolve(dir);
  const manifestPath = join(root, 'block.json');
  if (!existsSync(manifestPath)) {
    log.error(`No block.json in ${root} — run this inside a block repo.`);
    process.exitCode = 1;
    return;
  }

  // readLocalBlock also folds code/ into the manifest, matching install shape.
  let manifest: ReturnType<typeof readLocalBlock>;
  try {
    manifest = readLocalBlock(root);
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const issues: string[] = [];

  const core = await loadCoreValidator();
  if (core) {
    try {
      core.parseManifest(manifest);
      log.success('Manifest passes the platform Zod schema.');
    } catch (err) {
      issues.push((err as Error).message);
    }
  } else {
    log.warn(
      'Could not load @ion-drive/core for authoritative validation — install it (or run inside an Ion Drive project). Structural checks only.',
    );
  }

  issues.push(...structuralManifestChecks(manifest));

  if (issues.length > 0) {
    for (const issue of issues) log.error(issue);
    process.exitCode = 1;
    return;
  }
  const actions = (manifest.actions ?? []) as unknown[];
  const hooks = (manifest.hooks ?? []) as unknown[];
  log.success(
    `${c.bold(String(manifest.name))} looks good — ${(manifest.code ?? []).length} code file(s), ${actions.length} action(s), ${hooks.length} hook(s).`,
  );
}

/**
 * Fallback checks the CLI can make without core (exported pure for unit
 * tests): code presence for declared handlers, plus the manifest-v1 grammar
 * (spec-02) — strict semver `version`, `dependencies` as a name → range
 * record with valid ranges, and a valid `requires.core` range. Core's
 * `parseManifest` is authoritative when resolvable; these keep `block
 * validate` useful when it isn't.
 */
export function structuralManifestChecks(manifest: Manifest): string[] {
  return [...vendoredCodeIssues(manifest), ...manifestGrammarIssues(manifest)];
}

/** Declared actions/hooks must ship vendored code with a plugin entry point. */
function vendoredCodeIssues(manifest: Manifest): string[] {
  const issues: string[] = [];
  const code = manifest.code ?? [];
  const declaresLogic =
    ((manifest.actions as unknown[] | undefined) ?? []).length > 0 ||
    ((manifest.hooks as unknown[] | undefined) ?? []).length > 0;
  if (declaresLogic && code.length === 0) {
    issues.push(
      'The manifest declares actions/hooks but there is no code/ directory (or embedded code) to vendor.',
    );
  }
  if (declaresLogic && !code.some((f) => f.path === 'index.ts')) {
    issues.push('Vendored code must include an index.ts (the plugin entry the barrel imports).');
  }
  return issues;
}

/**
 * Manifest v1 grammar (spec-02). Version uses canonical-equality (not
 * truthiness) so a "v" prefix or build metadata is rejected instead of
 * silently normalised.
 */
function manifestGrammarIssues(manifest: Manifest): string[] {
  const issues: string[] = [];
  const version = manifest.version;
  if (version !== undefined && (typeof version !== 'string' || semver.valid(version) !== version)) {
    issues.push(
      `version must be a canonical semver version like "0.2.0" (no "v" prefix, no build metadata); got ${JSON.stringify(version)}`,
    );
  }
  issues.push(...dependencyRecordIssues(manifest.dependencies));
  const core = (manifest.requires as { core?: unknown } | undefined)?.core;
  if (core !== undefined && (typeof core !== 'string' || semver.validRange(core) === null)) {
    issues.push(
      `requires.core must be a valid semver range (e.g. ">=0.2.0 <1.0.0"); got ${JSON.stringify(core)}`,
    );
  }
  return issues;
}

/** `dependencies` must be a name → semver-range record (never the legacy array). */
function dependencyRecordIssues(deps: unknown): string[] {
  if (deps === undefined) return [];
  if (Array.isArray(deps)) {
    return [
      'dependencies is the legacy array form — manifest v1 uses a name → semver-range record, e.g. {"crm": "^0.2.0"}',
    ];
  }
  if (deps === null || typeof deps !== 'object') {
    return ['dependencies must be a name → semver-range record, e.g. {"crm": "^0.2.0"}'];
  }
  const issues: string[] = [];
  for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      issues.push(
        `dependencies.${name} must be a valid semver range (e.g. "^0.2.0"); got ${JSON.stringify(range)}`,
      );
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// block pack
// ---------------------------------------------------------------------------

export async function blockPackCommand(dir = '.'): Promise<void> {
  const root = resolve(dir);
  if (!existsSync(join(root, 'block.json'))) {
    log.error(`No block.json in ${root} — run this inside a block repo.`);
    process.exitCode = 1;
    return;
  }
  let manifest: ReturnType<typeof readLocalBlock>;
  try {
    manifest = readLocalBlock(root); // embeds code/ into manifest.code
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  // Artifacts are immutable per (name, version): pack emits the versioned
  // path a registry version entry points at (spec-05 D8 — the legacy mutable
  // dist/block.json path is retired).
  const version = String(manifest.version ?? '');
  if (semver.valid(version) !== version) {
    log.error(
      `block.json needs a canonical semver "version" (e.g. "0.1.0") before packing; got ${JSON.stringify(manifest.version)}`,
    );
    process.exitCode = 1;
    return;
  }

  const distPath = join(root, 'dist', version, 'block.json');
  mkdirSync(dirname(distPath), { recursive: true });
  // packBytes is the shared renderer (spec-04): a digest computed over a
  // local block equals the digest of the published artifact packed from it.
  writeFileSync(distPath, packBytes(manifest));
  log.success(
    `Packed ${c.bold(String(manifest.name))}${c.meteor(`@${version}`)} → ${c.cyan(join(basename(root), 'dist', version, 'block.json'))} (${(manifest.code ?? []).length} code file(s) embedded)`,
  );
}

// ---------------------------------------------------------------------------
// block publish (spec-05 §2)
// ---------------------------------------------------------------------------

/**
 * Injectable subprocess seam — ALL `gh`/`git` invocations go through it so
 * the publish flow is unit-testable with a stubbed runner.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string }>;

/** The D6 "no gh" pointer (only the PR path needs the GitHub CLI). */
export const GH_MISSING_MESSAGE =
  'GitHub CLI not found — install it (https://cli.github.com) or use --direct (plain git push)';

/** The `execFile` slice the real runner needs — injected in tests. */
type ExecFileLike = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; maxBuffer: number },
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => unknown;

/** Real runner factory: stderr folded into failures, gh-ENOENT made friendly. */
export function createCommandRunner(exec: ExecFileLike = execFile): CommandRunner {
  return (cmd, args, opts) =>
    new Promise((resolvePromise, reject) => {
      exec(cmd, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolvePromise({ stdout });
        if (cmd === 'gh' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new PublishError(GH_MISSING_MESSAGE));
        }
        reject(
          new PublishError(`\`${cmd} ${args.join(' ')}\` failed: ${stderr.trim() || err.message}`),
        );
      });
    });
}

export const realCommandRunner: CommandRunner = createCommandRunner();

/** Expected publish failures — caught and rendered, never a stack trace. */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

export interface PublishOptions {
  /** Target registry repo: `owner/repo`, a full git URL, or a local path. */
  registryRepo?: string;
  /** Open a PR (default). */
  pr?: boolean;
  /** Push straight to the default branch instead of opening a PR. */
  direct?: boolean;
  /** Stop after the temp-dir build, printing the plan. */
  dryRun?: boolean;
  json?: boolean;
  /** Injectable seams (tests). */
  runner?: CommandRunner;
  now?: () => Date;
}

/**
 * The honest incentive line (spec-05 §2): local publishes are `community`
 * until CI attests. Printed to the terminal AND embedded in the PR body.
 */
export const PROVENANCE_NOTE =
  'Publishing locally cannot attest provenance. Merge via the publish workflow (or let CI attest on main) to get the ✔ verified badge.';

/** The rendered PR body: version, digest, dependency table, provenance note. */
export function renderPublishBody(input: {
  name: string;
  version: string;
  digest: string;
  size: number;
  dependencies: Record<string, string>;
  requiresCore?: string;
}): string {
  const deps = Object.entries(input.dependencies);
  const depTable =
    deps.length === 0
      ? '_none_'
      : [
          '| Depends on | Range |',
          '|---|---|',
          ...deps.map(([n, r]) => `| ${n} | \`${r}\` |`),
        ].join('\n');
  return [
    `Publish \`${input.name}@${input.version}\`.`,
    '',
    '| | |',
    '|---|---|',
    `| Version | \`${input.version}\` |`,
    `| Digest | \`${input.digest}\` |`,
    `| Size | ${input.size} bytes |`,
    ...(input.requiresCore ? [`| Requires core | \`${input.requiresCore}\` |`] : []),
    '',
    '### Dependencies',
    '',
    depTable,
    '',
    `> ${PROVENANCE_NOTE}`,
  ].join('\n');
}

/** Uniform publish failure: JSON `{ error }` in --json mode, styled otherwise. */
function failPublish(message: string, options: PublishOptions): void {
  if (options.json) console.log(JSON.stringify({ error: message }, null, 2));
  else log.error(message);
  process.exitCode = 1;
}

export async function blockPublishCommand(dir = '.', options: PublishOptions = {}): Promise<void> {
  // 1. Validate — hard fail BEFORE any network/clone work. Core is mandatory
  //    here (the temp-dir `registry build` needs its strict parsers anyway).
  const validated = await validatePublishSource(resolve(dir), options);
  if (!validated) return;
  const { root, core, manifest, name, version } = validated;

  // 2. Resolve the target registry repo (flag beats manifest publishConfig).
  const meta = (manifest.meta ?? {}) as { publishConfig?: { registryRepo?: string } };
  const repoRef = options.registryRepo ?? meta.publishConfig?.registryRepo;
  if (!repoRef) {
    failPublish(
      'No target registry repo — pass --registry-repo <owner/repo> or set meta.publishConfig.registryRepo in block.json.',
      options,
    );
    return;
  }

  const runner = options.runner ?? realCommandRunner;
  const tempDir = mkdtempSync(join(tmpdir(), 'ion-publish-'));
  const cloneDir = join(tempDir, 'registry');
  try {
    await runPublishFlow({
      root,
      name,
      version,
      manifest,
      repoRef,
      cloneDir,
      runner,
      core,
      options,
    });
  } catch (err) {
    if (err instanceof PublishError) {
      failPublish(err.message, options);
      return;
    }
    throw err;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** The pre-clone gate: block.json present, core loadable, manifest valid, semver version. */
async function validatePublishSource(
  root: string,
  options: PublishOptions,
): Promise<{
  root: string;
  core: NonNullable<Awaited<ReturnType<typeof loadCoreValidator>>>;
  manifest: Manifest;
  name: string;
  version: string;
} | null> {
  if (!existsSync(join(root, 'block.json'))) {
    failPublish(`No block.json in ${root} — run this inside a block repo.`, options);
    return null;
  }
  const core = await loadCoreValidator();
  if (!core) {
    failPublish(CORE_REQUIRED_MESSAGE, options);
    return null;
  }
  let manifest: Manifest;
  try {
    manifest = readLocalBlock(root);
    core.parseManifest(manifest);
  } catch (err) {
    failPublish((err as Error).message, options);
    return null;
  }
  const issues = structuralManifestChecks(manifest);
  if (issues.length > 0) {
    for (const issue of issues) log.error(issue);
    process.exitCode = 1;
    return null;
  }
  const version = String(manifest.version ?? '');
  if (semver.valid(version) !== version) {
    failPublish(
      `block.json needs a canonical semver "version" before publishing; got ${JSON.stringify(manifest.version)}`,
      options,
    );
    return null;
  }
  return { root, core, manifest, name: String(manifest.name), version };
}

/** Everything the clone→copy→build→commit→PR/push pipeline threads through. */
interface PublishContext {
  root: string;
  name: string;
  version: string;
  manifest: Manifest;
  repoRef: string;
  cloneDir: string;
  runner: CommandRunner;
  core: NonNullable<Awaited<ReturnType<typeof loadCoreValidator>>>;
  options: PublishOptions;
}

async function runPublishFlow(ctx: PublishContext): Promise<void> {
  const { name, version, options } = ctx;
  const direct = options.direct === true;

  await clonePublishTarget(ctx, direct);
  copyBlockSource(ctx);

  // 3. `registry build` in the clone — the same generator CI runs, so
  //    immutability refusals surface here before anything is pushed.
  const built = buildRegistry(ctx.cloneDir.split('\\').join('/'), {
    fs: realBuildFs(),
    now: ctx.options.now,
    validator: ctx.core,
  });
  if (built.refusals.length > 0) {
    throw new PublishError(
      `registry build refused:\n${built.refusals.map((r) => `  ${r}`).join('\n')}`,
    );
  }

  const packedEntry = built.packed.find((p) => p.name === name && p.version === version);
  const digest = packedEntry?.digest ?? computeDigest(packBytes(ctx.manifest));
  const size = packedEntry?.size ?? packBytes(ctx.manifest).byteLength;
  const body = renderPublishBody({
    name,
    version,
    digest,
    size,
    dependencies: (ctx.manifest.dependencies as Record<string, string> | undefined) ?? {},
    requiresCore: (ctx.manifest.requires as { core?: string } | undefined)?.core,
  });

  // 4. Dry run stops here with the would-publish plan.
  if (options.dryRun) {
    reportPublish(ctx, { digest, size, mode: direct ? 'direct' : 'pr', dryRun: true });
    return;
  }

  const branch = `publish/${name}-${version}`;
  if (!direct) await ctx.runner('git', ['checkout', '-b', branch], { cwd: ctx.cloneDir });

  await ctx.runner('git', ['add', '-A'], { cwd: ctx.cloneDir });
  const status = await ctx.runner('git', ['status', '--porcelain'], { cwd: ctx.cloneDir });
  if (status.stdout.trim() === '') {
    log.info(`Nothing to publish — ${c.bold(`${name}@${version}`)} is already in ${ctx.repoRef}.`);
    return;
  }
  await ctx.runner('git', ['commit', '-m', `publish: ${name}@${version}`], { cwd: ctx.cloneDir });

  let prUrl: string | undefined;
  if (direct) {
    await ctx.runner('git', ['push', 'origin', 'HEAD'], { cwd: ctx.cloneDir });
  } else {
    await ctx.runner('git', ['push', '-u', 'origin', branch], { cwd: ctx.cloneDir });
    const pr = await ctx.runner(
      'gh',
      ['pr', 'create', '--title', `publish: ${name}@${version}`, '--body', body],
      { cwd: ctx.cloneDir },
    );
    prUrl = pr.stdout.trim().split('\n').pop();
  }

  reportPublish(ctx, { digest, size, mode: direct ? 'direct' : 'pr', dryRun: false, prUrl });
}

/** Clones the target registry repo: `gh` for the PR path, plain git for --direct. */
async function clonePublishTarget(ctx: PublishContext, direct: boolean): Promise<void> {
  if (direct) {
    // Accept owner/repo, any git URL, or a local path (self-hosted registries).
    const isBare = /^[\w.-]+\/[\w.-]+$/.test(ctx.repoRef) && !existsSync(ctx.repoRef);
    const remote = isBare ? `https://github.com/${ctx.repoRef}.git` : ctx.repoRef;
    await ctx.runner('git', ['clone', '--depth', '1', remote, ctx.cloneDir]);
    return;
  }
  await ctx.runner('gh', ['repo', 'clone', ctx.repoRef, ctx.cloneDir, '--', '--depth', '1']);
}

/**
 * Copies the block's source directory into the clone at `<name>/` (block.json
 * + code/ + docs — never `dist/`, which the build regenerates). Refuses when
 * the target already carries the same name+version with different content.
 */
function copyBlockSource(ctx: PublishContext): void {
  const target = join(ctx.cloneDir, ctx.name);
  const targetManifest = join(target, 'block.json');
  if (existsSync(targetManifest)) {
    const existing = readLocalBlock(target);
    if (
      String(existing.version) === ctx.version &&
      !bytesEq(packBytes(existing), packBytes(ctx.manifest))
    ) {
      throw new PublishError(
        `${ctx.repoRef} already contains ${ctx.name}@${ctx.version} with different content — published versions are immutable; bump the version in block.json.`,
      );
    }
  }
  cpSync(ctx.root, target, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ctx.root.length).split('\\').join('/');
      return !/^\/(dist|node_modules|\.git)(\/|$)/.test(rel);
    },
  });
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** Terminal (or --json) summary + the honest provenance note. */
function reportPublish(
  ctx: PublishContext,
  outcome: { digest: string; size: number; mode: 'pr' | 'direct'; dryRun: boolean; prUrl?: string },
): void {
  const { name, version, options } = ctx;
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          block: name,
          version,
          digest: outcome.digest,
          size: outcome.size,
          registryRepo: ctx.repoRef,
          mode: outcome.mode,
          dryRun: outcome.dryRun,
          ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
          provenanceNote: PROVENANCE_NOTE,
        },
        null,
        2,
      ),
    );
    return;
  }
  log.raw();
  if (outcome.dryRun) {
    log.info(`Dry run — would publish ${c.bold(`${name}@${version}`)} to ${c.cyan(ctx.repoRef)}`);
  } else if (outcome.prUrl) {
    log.success(`Opened ${c.cyan(outcome.prUrl)} — publish: ${c.bold(`${name}@${version}`)}`);
  } else {
    log.success(`Pushed publish: ${c.bold(`${name}@${version}`)} to ${c.cyan(ctx.repoRef)}`);
  }
  log.bullet(`digest  ${c.dim(outcome.digest)}`);
  log.bullet(`size    ${outcome.size} bytes`);
  log.raw();
  log.warn(PROVENANCE_NOTE);
}
