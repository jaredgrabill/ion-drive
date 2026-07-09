/**
 * Templates for `ion-drive block new` (spec-06 §2) — pure functions/constants
 * consumed by `commands/block.ts`. The regenerated scaffold gives a block repo
 * the full SDLC out of the box:
 *
 *   block.json                    manifest ($schema, semver, requires.core preset)
 *   code/index.ts                 definePlugin skeleton
 *   test/fixtures.json            block-test fixtures skeleton
 *   test/smoke.test.ts            node:test example on the env contract
 *   README.md                     the dev loop: add ../block-x → block test → publish
 *   .github/workflows/ci.yml      validate → pack → block test (Postgres service) → drift
 *   .github/workflows/publish.yml thin caller of the reusable publish workflow (spec-05)
 *   .gitignore / .gitattributes   (-text on artifacts: digests are over exact bytes)
 *
 * Version-derived presets (`requires.core`, the CI npm pins) come from
 * CLI_VERSION so scaffolds track the release train.
 */

import { CLI_VERSION } from '../version-check.js';

/** `0.3.1` → `>=0.3.0 <1.0.0` — the scaffold's `requires.core` preset. */
export function coreRangePreset(cliVersion: string = CLI_VERSION): string {
  const match = /^(\d+)\.(\d+)/.exec(cliVersion);
  const major = match?.[1] ?? '0';
  const minor = match?.[2] ?? '0';
  return `>=${major}.${minor}.0 <1.0.0`;
}

/** `0.3.1` → `^0.3` — the CI workflow's npm install pin. */
export function npmPin(cliVersion: string = CLI_VERSION): string {
  const match = /^(\d+)\.(\d+)/.exec(cliVersion);
  return `^${match?.[1] ?? '0'}.${match?.[2] ?? '0'}`;
}

export function titleCase(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The scaffold's example object name (`stripe-billing` → `stripe_billing_items`). */
export function scaffoldObjectName(name: string): string {
  return `${name.replace(/-/g, '_')}_items`;
}

/** Manifest skeleton for a freshly scaffolded block. */
export function manifestSkeleton(name: string): string {
  return `${JSON.stringify(
    {
      $schema: 'https://ion-drive.dev/schemas/block-manifest.v1.json',
      name,
      version: '0.1.0',
      title: titleCase(name),
      description: `The ${name} building block.`,
      categories: [],
      dependencies: {},
      objects: [
        {
          name: scaffoldObjectName(name),
          displayName: `${titleCase(name)} Items`,
          fields: [{ name: 'title', displayName: 'Title', columnType: 'text', isRequired: true }],
        },
      ],
      actions: [],
      hooks: [],
      requires: { core: coreRangePreset(), handlers: [], plugins: [] },
    },
    null,
    2,
  )}\n`;
}

/** `code/index.ts` — the definePlugin skeleton vendored into consuming projects. */
export function codeIndexSkeleton(name: string): string {
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

/** `test/fixtures.json` — the empty block-test fixtures skeleton (spec-06 §1). */
export const FIXTURES_SKELETON = `${JSON.stringify({ actions: {}, seedChecks: {} }, null, 2)}\n`;

/**
 * `test/smoke.test.ts` — a zero-dependency node:test example on the block-test
 * env contract (`ion-drive block test` runs it with ION_TEST_SERVER_URL and
 * ION_TEST_API_KEY pointing at the live instance).
 */
export function smokeTestSkeleton(name: string): string {
  const object = scaffoldObjectName(name);
  return `/**
 * Block-local smoke test — \`ion-drive block test\` runs every test/*.test.ts
 * under \`tsx --test\` with the block installed on a live server:
 *
 *   ION_TEST_SERVER_URL  base URL of the (ephemeral or --server) instance
 *   ION_TEST_API_KEY     an admin-role API key minted for the run
 *
 * Plain node:test + fetch — no framework lock-in, no dependencies.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const base = process.env.ION_TEST_SERVER_URL ?? '';
const apiKey = process.env.ION_TEST_API_KEY ?? '';

test('the test server is healthy', async () => {
  assert.ok(base, 'ION_TEST_SERVER_URL must be set by ion-drive block test');
  const res = await fetch(\`\${base}/health\`);
  assert.equal(res.status, 200);
});

test('${object} answers the data API', async () => {
  const res = await fetch(\`\${base}/api/v1/data/${object}\`, {
    headers: { 'x-api-key': apiKey },
  });
  assert.equal(res.status, 200);
});
`;
}

/** Block README — the authoring dev loop, testing, and both publish paths. */
export function blockReadme(name: string): string {
  return `# block-${name}

An [Ion Drive](https://github.com/jaredgrabill/ion-drive) building block.

- \`block.json\` — the manifest (objects, actions, hooks, requirements)
- \`code/\` — vendored TypeScript copied into consuming projects at \`blocks/${name}/\`
- \`test/\` — block-local tests + \`fixtures.json\` for \`ion-drive block test\`
- \`dist/<version>/block.json\` — the immutable distributable artifact (\`ion-drive block pack\`)

## Develop

\`\`\`bash
ion-drive block validate    # manifest + code checks
ion-drive block pack        # emit dist/<version>/block.json (embeds code/)
ion-drive block test        # boot an ephemeral server, install for real, assert
\`\`\`

\`block test\` needs a reachable Postgres (\`--database-url\` or
\`ION_DATABASE_URL\`); it creates and drops its own scratch database. Its
built-in suite checks the install report, every object's data endpoint, every
action's reachability, and that uninstall leaves no residue — then runs your
\`test/*.test.ts\` under \`tsx --test\` with \`ION_TEST_SERVER_URL\` /
\`ION_TEST_API_KEY\` set. Optional \`test/fixtures.json\` supplies action inputs
and seed-count expectations.

For the inner loop against a running dev project:
\`ion-drive block test . --server http://localhost:3000\` (refuses servers with
existing user objects unless \`--force\`) — or install it for real with
\`ion-drive add ../block-${name}\` from a scaffolded project.

## Publish

Two paths (see \`.github/workflows/publish.yml\`):

- **PR to an existing registry**: \`ion-drive block publish --registry-repo
  <owner>/<registry-repo>\` opens a publish PR; the registry's CI attests on
  merge (the ✔ verified badge).
- **Own-repo registry**: make this repo a protocol-v1 registry
  (\`registry.config.json\` + Pages) and let \`publish.yml\` release every
  version bump on \`main\`.

Released \`(name, version)\` artifacts are immutable — bump the version for any
change. Consumers pick new versions up with \`ion-drive diff ${name}\` /
\`ion-drive update ${name}\` (their edits to vendored code are never
overwritten — updates to touched files land beside them as \`<file>.new\`).
`;
}

/** `.github/workflows/ci.yml` — validate → pack → block test → drift guard. */
export function blockCi(cliVersion: string = CLI_VERSION): string {
  const pin = npmPin(cliVersion);
  return `# Block CI (spec-06): validate + pack, then the real install-and-run loop —
# \`ion-drive block test\` boots an ephemeral Ion Drive server against the
# service container's Postgres, installs this block, asserts, and uninstalls.
name: ci
on:
  push: { branches: [main] }
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      # The CLI drives everything; core supplies the strict parsers and the
      # ephemeral server (\`block test\` imports its createServer()).
      - run: npm install -g @ion-drive/cli@${pin} @ion-drive/core@${pin}

      - run: ion-drive block validate .
      - run: ion-drive block pack .
      - run: >-
          ion-drive block test . --json
          --database-url postgresql://postgres:postgres@localhost:5432/postgres

      # Committed artifacts must match the sources (emit drift guard) — a
      # modified tracked artifact or an uncommitted new one both fail.
      - run: git diff --exit-code -- 'dist/'
      - run: test -z "$(git ls-files --others --exclude-standard -- dist/)"
`;
}

/** `.github/workflows/publish.yml` — thin caller of the reusable publish workflow. */
export function blockPublishWorkflow(name: string): string {
  return `# Publishing this block (spec-05/spec-06). Two supported paths:
#
# A) PR to an existing registry (no workflow needed here — comment this file's
#    job out if you take this path): from this directory run
#
#        ion-drive block publish --registry-repo <owner>/<registry-repo>
#
#    which opens a publish PR against the registry repo; ITS publish workflow
#    attests on merge (that is where the ✔ verified badge comes from).
#
# B) Own-repo registry (this workflow): make this repo a protocol-v1 registry —
#    add a registry.config.json ({ "name": "…" }), serve registry/ (GitHub
#    Pages), and every merge to main publishes unreleased versions via the
#    reusable workflow below. Manual dispatch defaults to a dry run.
name: publish
on:
  push: { branches: [main] }
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: true

jobs:
  publish:
    uses: jaredgrabill/ion-drive-blocks/.github/workflows/publish-block.yml@v1
    with:
      dry-run: \${{ inputs.dry-run || false }}
      block: ${name}
    permissions:
      contents: write
      id-token: write
      attestations: write
`;
}

export const BLOCK_GITIGNORE = `node_modules/
`;

/**
 * `.gitattributes` — released artifacts and attestation bundles are hashed
 * over their exact bytes (spec-04); autocrlf must never rewrite them.
 */
export const BLOCK_GITATTRIBUTES = `# sha256 digests are computed over exact bytes: a Windows checkout with
# core.autocrlf would otherwise serve CRLF-mangled artifacts that fail every
# consumer's digest verification. Keep these patterns covering all released
# files.
dist/** -text
*.sigstore.json -text
`;
