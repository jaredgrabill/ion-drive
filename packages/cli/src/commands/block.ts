/**
 * `ion-drive block <new|validate|pack>` — the block-authoring toolchain
 * (Phase 14 Tier 4, ADR-018 amendment).
 *
 * Blocks live outside the platform monorepo (official ones as directories of
 * the `jaredgrabill/ion-drive-blocks` repo; third-party ones anywhere), each authored in the
 * same simple layout:
 *
 *   block.json   — the manifest (source of truth; no embedded code)
 *   code/        — vendored TypeScript files, when the block ships logic
 *   dist/block.json — the distributable artifact (`pack` embeds code/ here);
 *                     the registry index points at this file
 *
 * `new` scaffolds that layout; `validate` runs the platform's Zod parser over
 * the manifest (via an optional dynamic import of core — present in framework
 * projects and the monorepo) plus structural code checks; `pack` emits the
 * artifact. CI in a block repo is just `validate` + `pack` + drift check.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readLocalBlock } from '../registry/registry-client.js';
import { c, log, sym } from '../ui.js';

// ---------------------------------------------------------------------------
// block new
// ---------------------------------------------------------------------------

/** Manifest skeleton for a freshly scaffolded block. */
function manifestSkeleton(name: string): string {
  return `${JSON.stringify(
    {
      $schema: 'https://ion-drive.dev/schemas/block-manifest.json',
      name,
      version: '0.1.0',
      title: titleCase(name),
      description: `The ${name} building block.`,
      categories: [],
      dependencies: [],
      objects: [
        {
          name: `${name.replace(/-/g, '_')}_items`,
          displayName: `${titleCase(name)} Items`,
          fields: [{ name: 'title', displayName: 'Title', columnType: 'text', isRequired: true }],
        },
      ],
      actions: [],
      hooks: [],
      requires: { handlers: [], plugins: [] },
    },
    null,
    2,
  )}\n`;
}

function codeIndexSkeleton(name: string): string {
  return `/**
 * ${titleCase(name)} block — vendored logic entry point.
 *
 * This file is copied into consuming projects at blocks/${name}/index.ts and
 * loaded through the plugin host. Register the handlers your block.json
 * declares (actions/hooks) in \`setup\`; install fails with a clear error if a
 * declared handler is missing.
 */
import { definePlugin } from '@ion-drive/core';

export default definePlugin({
  name: '${name}',
  setup(ctx) {
    // Example action — declare it in block.json under "actions" to expose it:
    // ctx.actions.registerAction({
    //   block: '${name}',
    //   name: 'ping',
    //   handler: async () => ({ pong: true }),
    // });
    ctx.logger.info('${name} block loaded');
  },
});
`;
}

function blockReadme(name: string): string {
  return `# block-${name}

An [Ion Drive](https://github.com/jaredgrabill/ion-drive) building block.

- \`block.json\` — the manifest (objects, actions, hooks, requirements)
- \`code/\` — vendored TypeScript copied into consuming projects at \`blocks/${name}/\`
- \`dist/block.json\` — the distributable artifact (\`ion-drive block pack\`)

## Develop

\`\`\`bash
ion-drive block validate    # manifest + code checks
ion-drive block pack        # emit dist/block.json (embeds code/)
\`\`\`

Test against a local project: \`ion-drive add ../block-${name}\` from a scaffolded
Ion Drive project (\`ion-drive init\`).
`;
}

const BLOCK_CI = `name: ci
on:
  push: { branches: [main] }
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @ion-drive/cli @ion-drive/core
      - run: ion-drive block validate
      - run: ion-drive block pack
      # The committed artifact must match the sources (emit drift guard).
      - run: git diff --exit-code dist/block.json
`;

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
    ['README.md', blockReadme(safe)],
    ['.github/workflows/ci.yml', BLOCK_CI],
    ['.gitignore', 'node_modules/\n'],
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

/** The slice of core the validator uses when it's installed nearby. */
interface CoreValidator {
  parseManifest: (input: unknown) => { name: string };
}

/**
 * Loads core's authoritative Zod parser when available. Resolution is tried
 * from the *current project* first (so a globally-installed CLI picks up the
 * project's own core install), then from the CLI's own dependency tree.
 */
async function loadCoreValidator(): Promise<CoreValidator | null> {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  try {
    const projectRequire = createRequire(join(process.cwd(), 'package.json'));
    const resolved = projectRequire.resolve('@ion-drive/core');
    return (await import(pathToFileURL(resolved).href)) as unknown as CoreValidator;
  } catch {
    /* fall through to the CLI's own tree */
  }
  try {
    return (await import('@ion-drive/core')) as unknown as CoreValidator;
  } catch {
    return null;
  }
}

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

  issues.push(...structuralChecks(manifest, root));

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

/** Checks the CLI can make without core: code presence for declared handlers. */
function structuralChecks(manifest: ReturnType<typeof readLocalBlock>, root: string): string[] {
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
  if (code.length > 0 && !existsSync(join(root, 'code'))) {
    // Embedded-code manifests are fine too — nothing to check on disk.
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

  const distPath = join(root, 'dist', 'block.json');
  mkdirSync(dirname(distPath), { recursive: true });
  writeFileSync(distPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log.success(
    `Packed ${c.bold(String(manifest.name))} → ${c.cyan(join(basename(root), 'dist', 'block.json'))} (${(manifest.code ?? []).length} code file(s) embedded)`,
  );
}

function titleCase(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
