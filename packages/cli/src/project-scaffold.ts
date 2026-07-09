/**
 * Full project scaffolding for `ion-drive init` (Phase 14, ADR-018).
 *
 * Writes a user-owned framework project: a `server.ts` composition root around
 * `createServer`, an empty `/blocks` barrel, env files with secure generated
 * secrets, Postgres via docker-compose, the `ion/` client starter, and the
 * agent-instructions layer (`AGENTS.md` + starter skills) — the platform is
 * built for agentic development, so the scaffold teaches agents too.
 *
 * The first impression is deliberately minimal: an entrypoint and `/blocks`.
 * Everything else lives in the npm dependencies. Files are only written when
 * missing — the scaffold never clobbers existing code.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { EMPTY_BARREL } from './project.js';
import { CLI_VERSION } from './version-check.js';

/** `package.json` — pinned to the CLI's release train (fixed version group). */
function packageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      version: '0.1.0',
      type: 'module',
      description: 'An Ion Drive application backend',
      scripts: {
        dev: 'tsx watch server.ts',
        start: 'tsx server.ts',
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        '@ion-drive/admin': `^${CLI_VERSION}`,
        '@ion-drive/client': `^${CLI_VERSION}`,
        '@ion-drive/core': `^${CLI_VERSION}`,
        tsx: '^4.19.0',
        zod: '^3.24.0',
      },
      devDependencies: {
        // The CLI as a local devDep so `npx ion-drive …` resolves to the
        // project's pinned version (the bare npm name is not ours).
        '@ion-drive/cli': `^${CLI_VERSION}`,
        '@types/node': '^22.10.0',
        typescript: '^5.7.0',
      },
    },
    null,
    2,
  )}\n`;
}

const TSCONFIG_JSON = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['server.ts', 'blocks/**/*.ts', 'ion/**/*.ts'],
  },
  null,
  2,
)}\n`;

const SERVER_TS = `/**
 * Ion Drive composition root — this file is yours.
 *
 * \`createServer\` assembles the whole platform (schema engine, REST/GraphQL/MCP
 * APIs, auth, tasks, events, admin console at /admin) from ION_* environment
 * variables. The \`blocks\` barrel lists your vendored building blocks; each is
 * a plugin whose setup registers the block's actions and hooks.
 *
 * Run \`npm run dev\` (tsx watch) — editing anything here or under /blocks
 * hot-reloads the server.
 */
import { createServer } from '@ion-drive/core';
import { blocks } from './blocks/index.js';

// Load .env before config is read (absent file is fine on first boot).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env — fall back to real environment variables */
}

try {
  const { server, config } = await createServer(undefined, { plugins: blocks });
  await server.listen({ port: config.port, host: config.host });
  server.log.info(
    \`🚀 Ion Drive running at http://localhost:\${config.port} — admin console at /admin\`,
  );
} catch (err) {
  console.error('Ion Drive failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
}
`;

/** `.env` — real secrets are generated per project; safe local-dev defaults. */
function envFile(): string {
  return `# Ion Drive configuration — see .env.example for every knob.
# This file is gitignored; it holds this machine's real secrets.

ION_PORT=3000
ION_DATABASE_URL=postgresql://ion:ion@localhost:5432/ion_drive

# Generated for this project — keep them secret, rotate if leaked.
ION_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}
ION_AUTH_SECRET=${randomBytes(32).toString('hex')}
`;
}

const ENV_EXAMPLE = `# Ion Drive configuration template. Copy to .env and fill in secrets.

ION_PORT=3000
ION_DATABASE_URL=postgresql://ion:ion@localhost:5432/ion_drive

# 32-byte hex keys — generate with: openssl rand -hex 32
ION_ENCRYPTION_KEY=
ION_AUTH_SECRET=

# --- Production hardening (see the Ion Drive security checklist) ---
# ION_REQUIRE_AUTH=true          # enforce RBAC on every surface
# ION_DISABLE_SIGNUP=true        # close public signup once the first admin exists
# ION_TRUST_PROXY=true           # honour X-Forwarded-* behind a reverse proxy
# ION_METRICS_TOKEN=             # bearer token protecting GET /metrics
# ION_PUBLIC_URL=https://api.example.com
# ION_CORS_ORIGINS=https://app.example.com
`;

const DOCKER_COMPOSE = `# Local PostgreSQL for Ion Drive development (\`docker compose up -d\`).
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ion
      POSTGRES_PASSWORD: ion
      POSTGRES_DB: ion_drive
    ports:
      - '5432:5432'
    volumes:
      - ion_drive_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ion -d ion_drive']
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  ion_drive_pgdata:
`;

const GITIGNORE = `node_modules/
dist/
.env
*.log
`;

/**
 * Project CI (spec-06 §3): typecheck plus `ion-drive audit` — the ecosystem's
 * Dependabot-lite. The weekly schedule re-checks installed blocks against
 * their registries even when nobody is pushing (advisories/yanks land on the
 * registry side, not in this repo).
 */
const PROJECT_CI = `name: ci
on:
  push: { branches: [main] }
  pull_request:
  schedule:
    # Weekly audit: advisories, yanks, and registry drift surface over time.
    - cron: '0 7 * * 1'

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx tsc --noEmit
      # Audits ion.config.json's installed blocks against their registries:
      # exit 1 on advisories, yanked versions, or digest/ledger drift.
      - run: npx ion-drive audit
`;

/** Project README — the ten-minute loop, verbatim. */
function readme(name: string): string {
  return `# ${name}

An [Ion Drive](https://github.com/jaredgrabill/ion-drive) application backend — runtime-defined
data objects exposed automatically over REST, GraphQL, and MCP.

## Run it

\`\`\`bash
docker compose up -d      # PostgreSQL
npm install
npm run dev               # API on :3000, admin console at http://localhost:3000/admin
\`\`\`

Open http://localhost:3000/admin and sign up — the first user becomes admin.

## Add building blocks

\`\`\`bash
ion-drive add crm         # schema-only block: objects + APIs light up immediately
ion-drive add invoicing   # vendored-logic block: its code lands in blocks/invoicing/
\`\`\`

Blocks with logic are **your code**: edit \`blocks/<name>/*.ts\` and the dev
server hot-reloads. \`blocks/index.ts\` is the explicit list of loaded blocks
(maintained by \`ion-drive add/remove\`).

## Layout

- \`server.ts\` — composition root (yours to edit)
- \`blocks/\` — vendored building blocks (yours to edit)
- \`ion/\` — typed client starter using \`@ion-drive/client\`
- \`AGENTS.md\` — instructions for AI coding agents working in this repo
`;
}

const AGENTS_MD = `# Agent instructions — Ion Drive project

This is an [Ion Drive](https://github.com/jaredgrabill/ion-drive) backend: data objects (tables)
are defined **at runtime** and automatically exposed over REST, GraphQL, and MCP.

## Talking to the platform

- **MCP (preferred for agents):** \`POST http://localhost:3000/api/v1/mcp\` (Streamable HTTP,
  stateless). Tools cover schema introspection, CRUD, schema changes, and installed blocks'
  actions (\`<block>_<action>\`).
- **REST:** \`/api/v1/data/<object>\` — filters \`field[op]=value\` (\`eq neq gt gte lt lte like
  ilike in nin null notnull\`), free-text \`?q=\`, \`sort=-created_at\`, \`page/pageSize\` or
  \`limit/offset\`, \`expand=<relation>\`. OpenAPI at \`/api/v1/openapi.json\` is always current.
- **TypeScript SDK:** \`ion/client.ts\` exports a configured \`IonDriveClient\`. Fluent and
  awaitable: \`await ion.from('contacts').select().search('acme').neq('status', 'archived')\`.

## Changing schema — preview first

Schema changes are **previewed before applied**. Always dry-run first and read the SQL +
warnings, then apply:

\`\`\`
PATCH /api/v1/schema/objects/:name/fields/:field?dryRun=true   # preview (SQL + warnings)
PATCH /api/v1/schema/objects/:name/fields/:field               # apply
\`\`\`

Fields owned by a block (\`managedBy: block:<name>\`) are contract-protected; overriding
requires \`?force=true\` and is usually the wrong move — extend with new fields instead.

## Finding blocks

- \`ion-drive search <term>\` searches the configured registry (name, title,
  description, categories); \`ion-drive list\` browses the whole catalog.
- **Registry MCP (preferred for agents):** \`ion-drive mcp\` serves a stdio MCP
  server with \`search_blocks\`, \`get_block\` (version history + README),
  \`list_registries\`, and \`preview_install\` (full dependency resolution +
  digest/trust verification, never makes changes). Use it to *choose* blocks;
  the server MCP at \`/api/v1/mcp\` then works with the installed data.

## Blocks

- \`blocks/index.ts\` is the explicit barrel of loaded blocks — maintained by
  \`ion-drive add/remove\`; keep its marker comments intact.
- Vendored block code (\`blocks/<name>/\`) is project-owned: edit freely, the dev server
  hot-reloads. Actions are exposed at \`POST /api/v1/blocks/<block>/actions/<action>\`;
  inbound webhooks at \`/api/v1/hooks/<block>/<hook>\`.
- Server-side state (objects, tasks, roles, subscriptions) comes from the block's manifest —
  installed via \`ion-drive add\`, inspected via \`GET /api/v1/blocks\`.
- \`ion-drive audit\` checks installed blocks against their registries (advisories, yanked
  versions, digest/ledger drift) — CI runs it on every push and weekly.
`;

const SKILL_SCHEMA_CHANGE = `---
name: ion-schema-change
description: Make a schema change on this Ion Drive backend safely (preview-first contract)
---

# Ion Drive schema change

1. Inspect current state: \`GET /api/v1/schema/objects/:name\` (or the MCP \`get_object\` tool).
2. **Dry-run the change** and read the result — real SQL, warnings, and errors:
   \`PATCH /api/v1/schema/objects/:name/fields/:field?dryRun=true\` with the modification body.
3. If the preview reports \`REQUIRES_BACKFILL\`, include a \`backfillValue\`.
4. Apply (same request without \`dryRun\`). Never use \`force=true\` on \`block:\`-managed
   fields without asking the user — that overrides a block's contract.
5. Verify: re-fetch the object; confirm the API surface (\`/api/v1/openapi.json\`) reflects it.

New objects: \`POST /api/v1/schema/objects\` (or MCP \`create_object\`). New link fields
compose a relationship via \`POST /api/v1/schema/relationships\`.
`;

const SKILL_ADD_BLOCK = `---
name: ion-add-block
description: Install an Ion Drive building block (schema and/or vendored logic) into this project
---

# Add an Ion Drive building block

1. Discover: \`ion-drive search <term>\` (or \`ion-drive list\` for the whole catalog,
   \`ion-drive registry list\` for all configured registries). Agents: \`ion-drive mcp\`
   exposes \`search_blocks\`/\`get_block\`/\`list_registries\`/\`preview_install\` over stdio.
   Refs may be namespaced and range-pinned —
   \`crm\`, \`crm@^0.2.0\`, \`@acme/billing@1.x\` — or a URL / local path to a block.
2. Preview: \`ion-drive add <name> --dry-run\` shows objects, dependencies, and requirements.
3. Install: \`ion-drive add <name>\`. For blocks with vendored code this (a) copies the code
   to \`blocks/<name>/\`, (b) wires it into \`blocks/index.ts\`, then (c) installs the manifest
   into the running server — the dev server must be running (\`npm run dev\`).
4. Verify: \`GET /api/v1/blocks\` shows it installed; its objects appear in the schema and
   its actions in \`GET /api/v1/blocks/actions\` and the OpenAPI spec.
5. The vendored code is project-owned — edit it like any other file; hot-reload applies.

Remove with \`ion-drive remove <name>\` (schema is dropped; the vendored folder stays yours).
`;

interface ScaffoldFile {
  path: string;
  contents: string;
}

export interface ProjectScaffoldResult {
  created: string[];
  skipped: string[];
}

/**
 * Writes the framework project into `dir` (created if missing). Every file is
 * skip-if-exists; the caller reports `created`/`skipped` to the user.
 */
export function scaffoldProject(dir: string): ProjectScaffoldResult {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const name = sanitizeName(basename(root));

  const files: ScaffoldFile[] = [
    { path: 'package.json', contents: packageJson(name) },
    { path: 'tsconfig.json', contents: TSCONFIG_JSON },
    { path: 'server.ts', contents: SERVER_TS },
    { path: 'blocks/index.ts', contents: EMPTY_BARREL },
    { path: '.env', contents: envFile() },
    { path: '.env.example', contents: ENV_EXAMPLE },
    { path: 'docker-compose.yml', contents: DOCKER_COMPOSE },
    { path: '.gitignore', contents: GITIGNORE },
    { path: '.github/workflows/ci.yml', contents: PROJECT_CI },
    { path: 'README.md', contents: readme(name) },
    { path: 'AGENTS.md', contents: AGENTS_MD },
    { path: '.claude/skills/ion-schema-change/SKILL.md', contents: SKILL_SCHEMA_CHANGE },
    { path: '.claude/skills/ion-add-block/SKILL.md', contents: SKILL_ADD_BLOCK },
  ];

  const result: ProjectScaffoldResult = { created: [], skipped: [] };
  for (const file of files) {
    const target = join(root, file.path);
    if (existsSync(target)) {
      result.skipped.push(file.path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, 'utf8');
    result.created.push(file.path);
  }
  return result;
}

/** A directory name as a valid npm package name. */
function sanitizeName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'ion-drive-app';
}
