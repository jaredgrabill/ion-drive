/**
 * CLI-level integration suite for `ion-drive diff`/`update` (spec-07) —
 * shells the real CLI (`node --import tsx …`) from a temp project directory
 * against two in-process HTTP stubs on 127.0.0.1:
 *
 *  - a protocol-v1 **fixture registry** serving demo@{0.1.0,0.3.0,0.4.0} and
 *    other@2.0.0 as real byte artifacts (digests computed over those bytes,
 *    so the spec-04 verify gate runs for real);
 *  - a **stub Ion server** implementing /health, the blocks ledger, and
 *    /blocks/install with the spec-07 version gate (records every install).
 *
 * No Postgres needed. Covered: the six code statuses via `diff --json`
 * (AC1), the update write-set — pristine files overwritten, `.new` beside
 * user edits, user files untouched, config updated (AC1/AC5 via
 * `git status --porcelain` on a git-inited project), downgrade refusal
 * (AC3), and the deps-first refusal + `--with-deps` chain (AC3).
 */

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_BARREL } from '../project.js';
import { computeDigest, packBytes } from '../registry/verify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// Manifest + artifact fixtures
// ---------------------------------------------------------------------------

const demoManifest = (version: string, extra: Record<string, unknown> = {}) => ({
  name: 'demo',
  version,
  title: 'Demo Block',
  objects: [
    {
      name: 'demo_items',
      displayName: 'Demo Items',
      fields: [{ name: 'label', displayName: 'Label', columnType: 'text' }],
    },
  ],
  ...extra,
});

const code = (files: Record<string, string>) =>
  Object.entries(files).map(([path, contents]) => ({ path, contents }));

const demo020 = demoManifest('0.2.0', {
  code: code({
    'index.ts': '// v1\n',
    'handlers.ts': '// handlers v1\n',
    'util.ts': '// same\n',
    'legacy.ts': '// old\n',
  }),
});
const demo010 = demoManifest('0.1.0', { code: code({ 'index.ts': '// v0\n' }) });
const demo030 = demoManifest('0.3.0', {
  code: code({
    'index.ts': '// v2\n',
    'handlers.ts': '// handlers v2\n',
    'util.ts': '// same\n',
    'extra.ts': '// fresh\n',
  }),
});
const demo040 = demoManifest('0.4.0', {
  dependencies: { other: '^2.0.0' },
  code: code({ 'index.ts': '// v3\n' }),
});
const other100 = { name: 'other', version: '1.0.0', title: 'Other Block' };
const other200 = { name: 'other', version: '2.0.0', title: 'Other Block' };

const artifacts = new Map<string, Buffer>([
  ['/demo/dist/0.1.0/block.json', Buffer.from(packBytes(demo010))],
  ['/demo/dist/0.3.0/block.json', Buffer.from(packBytes(demo030))],
  ['/demo/dist/0.4.0/block.json', Buffer.from(packBytes(demo040))],
  ['/other/dist/2.0.0/block.json', Buffer.from(packBytes(other200))],
]);

const digestOf = (route: string) => {
  const bytes = artifacts.get(route);
  if (!bytes) throw new Error(`no artifact at ${route}`);
  return computeDigest(bytes);
};

function versionEntry(name: string, version: string, deps: Record<string, string> = {}) {
  const route = `/${name}/dist/${version}/block.json`;
  return {
    artifactUrl: `../..${route}`,
    digest: digestOf(route),
    size: artifacts.get(route)?.byteLength,
    publishedAt: '2026-07-08T00:00:00Z',
    dependencies: deps,
    requires: {},
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// The stub Ion server (ledger + spec-07 install gate)
// ---------------------------------------------------------------------------

interface RecordedInstall {
  name: string;
  version: string;
  upgrade: boolean;
  dryRun: boolean;
  force: boolean;
  sourceDigest?: string;
}

interface StubState {
  versions: Record<string, string>;
  snapshots: Record<string, unknown>;
  installs: RecordedInstall[];
}

function emptyReport(name: string, from: string, to: string, dryRun: boolean) {
  return {
    block: name,
    version: to,
    dryRun,
    objectsCreated: [],
    objectsSkipped: [],
    relationshipsCreated: [],
    recordsSeeded: {},
    tasksCreated: [],
    rolesCreated: [],
    rolesSkipped: [],
    subscriptionsRegistered: [],
    actionsExposed: [],
    hooksExposed: [],
    webhooksCreated: {},
    webhooksSkipped: [],
    released: [],
    skippedDestructive: [],
    tasksUpdated: [],
    tasksRemoved: [],
    webhooksUpdated: [],
    webhooksRemoved: [],
    upgraded: { from, to },
    delta: {
      from,
      to,
      objects: { added: [], removed: [] },
      fields: [{ objectName: 'demo_items', fieldName: 'status', kind: 'additive' }],
      relationships: { added: [], removed: [] },
      tasks: [],
      roles: [],
      subscriptions: { added: [], removed: [], changed: [] },
      webhooks: { added: [], removed: [], changed: [] },
      actions: { added: [], removed: [] },
      hooks: { added: [], removed: [] },
      seedChanged: false,
      code: { added: [], removed: [], changed: [] },
      hasChanges: true,
    },
    previews: dryRun
      ? [
          {
            target: 'add field demo_items.status',
            sqlStatements: ['ALTER TABLE "demo_items" ADD COLUMN "status" TEXT'],
            warnings: [],
            errors: [],
          },
        ]
      : [],
    warnings: [],
  };
}

function ledgerRow(state: StubState, name: string) {
  return {
    name,
    version: state.versions[name],
    title: name,
    status: 'installed',
    createdObjects: [],
    manifest: state.snapshots[name],
    sourceRegistry: '@fix',
    installedAt: '2026-07-08T00:00:00Z',
  };
}

/** Minimal spec-07 install gate: upgrade requires strictly-newer semver. */
function handleInstall(state: StubState, url: URL, body: Record<string, unknown>) {
  const manifest = (body.manifest ?? body) as { name: string; version: string };
  const source = body.source as { digest?: string } | undefined;
  const upgrade = url.searchParams.get('upgrade') === 'true';
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const force = url.searchParams.get('force') === 'true';
  const current = state.versions[manifest.name];

  if (upgrade) {
    if (current === undefined) {
      return {
        status: 404,
        body: { error: 'Not Found', code: 'NOT_FOUND', message: 'not installed' },
      };
    }
    if (semver.lte(manifest.version, current)) {
      return {
        status: 409,
        body: {
          error: 'Not An Upgrade',
          code: 'NOT_AN_UPGRADE',
          message: `Downgrade from ${current} to ${manifest.version} is not supported — recovery is \`ion-drive remove ${manifest.name}\` then \`ion-drive add ${manifest.name}@${manifest.version}\`.`,
        },
      };
    }
  }
  const report = emptyReport(manifest.name, current ?? manifest.version, manifest.version, dryRun);
  if (!dryRun) {
    state.installs.push({
      name: manifest.name,
      version: manifest.version,
      upgrade,
      dryRun,
      force,
      sourceDigest: source?.digest,
    });
    state.versions[manifest.name] = manifest.version;
    state.snapshots[manifest.name] = manifest;
  }
  return { status: dryRun ? 200 : 201, body: { data: report } };
}

/** Routes one GET request against the stub's read surface (null = no route). */
function stubReadResponse(
  state: StubState,
  pathname: string,
): { status: number; body: unknown } | null {
  if (pathname === '/health') {
    return { status: 200, body: { status: 'ok', version: '0.3.0', objectCount: 1 } };
  }
  if (pathname === '/api/v1/blocks') {
    return {
      status: 200,
      body: { data: Object.keys(state.versions).map((n) => ledgerRow(state, n)) },
    };
  }
  const blockMatch = /^\/api\/v1\/blocks\/([a-z_-]+)$/.exec(pathname);
  if (blockMatch) {
    const name = blockMatch[1] ?? '';
    if (!(name in state.versions)) return { status: 404, body: { error: 'Not Found' } };
    return { status: 200, body: { data: ledgerRow(state, name) } };
  }
  return null;
}

function startStubServer(state: StubState): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/blocks/install' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const result = handleInstall(state, url, JSON.parse(raw) as Record<string, unknown>);
        send(result.status, result.body);
      });
      return;
    }
    const read = req.method === 'GET' ? stubReadResponse(state, url.pathname) : null;
    if (read) return send(read.status, read.body);
    send(404, { error: 'Not Found', message: `no stub for ${req.method} ${url.pathname}` });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** The protocol-v1 fixture registry (index + block docs + byte artifacts). */
function startRegistry(): Promise<{ server: Server; url: string }> {
  const routes: Record<string, unknown> = {
    '/registry/index.json': {
      schemaVersion: 1,
      name: 'Fixture Registry',
      generatedAt: '2026-07-08T00:00:00Z',
      blocks: {
        demo: { latest: '0.3.0', blockUrl: 'blocks/demo.json' },
        other: { latest: '2.0.0', blockUrl: 'blocks/other.json' },
      },
    },
    '/registry/blocks/demo.json': {
      schemaVersion: 1,
      name: 'demo',
      latest: '0.3.0',
      versions: {
        '0.1.0': versionEntry('demo', '0.1.0'),
        '0.3.0': versionEntry('demo', '0.3.0'),
        '0.4.0': versionEntry('demo', '0.4.0', { other: '^2.0.0' }),
      },
    },
    '/registry/blocks/other.json': {
      schemaVersion: 1,
      name: 'other',
      latest: '2.0.0',
      versions: { '2.0.0': versionEntry('other', '2.0.0') },
    },
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const artifact = artifacts.get(path);
    if (artifact) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(artifact);
    }
    const doc = routes[path];
    if (doc === undefined) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(doc));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}/registry/index.json` });
    });
  });
}

// ---------------------------------------------------------------------------
// Project scaffolding + CLI runner
// ---------------------------------------------------------------------------

let registry: { server: Server; url: string };
let stub: { server: Server; url: string };
let state: StubState;
let project: string;
let cacheDir: string;

function git(args: string, cwd = project): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' });
}

function writeProjectFile(path: string, contents: string): void {
  const full = join(project, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(CLI_ROOT, 'src', 'index.ts'), ...args],
      {
        cwd: project,
        env: { ...process.env, ION_DRIVE_CACHE_DIR: cacheDir, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

beforeAll(async () => {
  registry = await startRegistry();
  state = {
    versions: { demo: '0.2.0', other: '1.0.0' },
    snapshots: { demo: demo020, other: other100 },
    installs: [],
  };
  stub = await startStubServer(state);

  project = mkdtempSync(join(tmpdir(), 'ion-update-'));
  cacheDir = join(project, '.registry-cache');
  // `--import tsx` resolves from the project dir — junction the CLI's deps in.
  symlinkSync(join(CLI_ROOT, 'node_modules'), join(project, 'node_modules'), 'junction');

  writeProjectFile(
    'ion.config.json',
    `${JSON.stringify(
      {
        serverUrl: stub.url,
        registries: { '@fix': registry.url },
        defaultRegistry: '@fix',
        blocks: [
          {
            name: 'demo',
            version: '0.2.0',
            digest: null,
            source: '@fix',
            installedAt: '2026-07-08T00:00:00Z',
          },
          {
            name: 'other',
            version: '1.0.0',
            digest: null,
            source: '@fix',
            installedAt: '2026-07-08T00:00:00Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  // Barrel pre-wired for demo, as `ion-drive add` would have left it.
  writeProjectFile(
    'blocks/index.ts',
    EMPTY_BARREL.replace(
      '// ion-drive:imports',
      "// ion-drive:imports\nimport demo from './demo/index.js';",
    ).replace('// ion-drive:blocks', '// ion-drive:blocks\n  demo,'),
  );
  // The vendored 0.2.0 tree, with one user edit + one user-created file.
  writeProjectFile('blocks/demo/index.ts', '// v1\n'); // pristine → overwritten
  writeProjectFile('blocks/demo/handlers.ts', '// my edits\n'); // touched → .new
  writeProjectFile('blocks/demo/util.ts', '// same\n'); // unchanged
  writeProjectFile('blocks/demo/legacy.ts', '// old\n'); // removed upstream
  writeProjectFile('blocks/demo/mine.ts', '// user-created\n'); // yours
  writeProjectFile('.gitignore', 'node_modules\n.registry-cache\n');

  git('init -q');
  git('add -A');
  git('-c user.name=it -c user.email=it@ion.test commit -q -m baseline');
}, 60_000);

afterAll(() => {
  registry?.server.close();
  stub?.server.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The suite (ordered; shares the stub state like a real project session)
// ---------------------------------------------------------------------------

describe('ion-drive diff', () => {
  it('reports the manifest delta and all six code statuses (--json)', async () => {
    const result = await runCli(['diff', 'demo', '--version', '0.3.0', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const jsonStart = result.stdout.indexOf('{');
    expect(jsonStart, `no JSON in stdout:\n${result.stdout}`).toBeGreaterThanOrEqual(0);
    const report = JSON.parse(result.stdout.slice(jsonStart)) as {
      current: string;
      target: string;
      delta: { fields: { fieldName: string; kind: string }[] };
      code: { path: string; status: string }[];
    };
    expect(report.current).toBe('0.2.0');
    expect(report.target).toBe('0.3.0');
    expect(report.delta.fields).toEqual([
      { objectName: 'demo_items', fieldName: 'status', kind: 'additive' },
    ]);
    const statuses = new Map(report.code.map((c) => [c.path, c.status]));
    expect(statuses.get('index.ts')).toBe('update-available');
    expect(statuses.get('handlers.ts')).toBe('modified-by-you');
    expect(statuses.get('util.ts')).toBe('unchanged');
    expect(statuses.get('legacy.ts')).toBe('removed-upstream');
    expect(statuses.get('extra.ts')).toBe('added-upstream');
    expect(statuses.get('mine.ts')).toBe('yours');
  }, 120_000);
});

describe('ion-drive update', () => {
  it('applies the update: safe overwrites, .new beside edits, yours intact, config + ledger updated', async () => {
    const result = await runCli(['update', 'demo', '--version', '0.3.0', '--yes']);
    expect(result.code, result.stderr + result.stdout).toBe(0);

    // Code writes honor the ownership contract.
    const read = (p: string) => readFileSync(join(project, 'blocks', 'demo', p), 'utf8');
    expect(read('index.ts')).toBe('// v2\n'); // pristine → overwritten
    expect(read('handlers.ts')).toBe('// my edits\n'); // untouched
    expect(read('handlers.ts.new')).toBe('// handlers v2\n'); // update beside it
    expect(read('mine.ts')).toBe('// user-created\n');
    expect(read('legacy.ts')).toBe('// old\n'); // reported, never deleted
    expect(read('extra.ts')).toBe('// fresh\n');
    expect(result.stdout).toContain('manual merge');
    expect(result.stdout).toContain('removed upstream');

    // The real install went through the upgrade path with the verified digest.
    const real = state.installs.find((i) => i.name === 'demo');
    expect(real).toMatchObject({
      version: '0.3.0',
      upgrade: true,
      force: false,
      sourceDigest: digestOf('/demo/dist/0.3.0/block.json'),
    });

    // ion.config.json records the new version + computed digest.
    const config = JSON.parse(readFileSync(join(project, 'ion.config.json'), 'utf8')) as {
      blocks: { name: string; version: string; digest: string | null }[];
    };
    const demo = config.blocks.find((b) => b.name === 'demo');
    expect(demo?.version).toBe('0.3.0');
    expect(demo?.digest).toBe(digestOf('/demo/dist/0.3.0/block.json'));
  }, 120_000);

  it('leaves exactly the expected paths dirty (AC5, git status --porcelain)', () => {
    const changed = git('status --porcelain')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[?A-Z]+\s+/, ''))
      .sort();
    expect(changed).toEqual([
      'blocks/demo/extra.ts',
      'blocks/demo/handlers.ts.new',
      'blocks/demo/index.ts',
      'ion.config.json',
    ]);
  });

  it('refuses a downgrade with the documented recovery, writing nothing', async () => {
    const before = git('status --porcelain');
    const result = await runCli(['update', 'demo', '--version', '0.1.0', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('Downgrade from 0.3.0 to 0.1.0');
    expect(result.stdout + result.stderr).toContain('ion-drive remove demo');
    expect(git('status --porcelain')).toBe(before);
  }, 120_000);

  it('refuses when dependency ranges are unmet, printing the ordered plan', async () => {
    const installsBefore = state.installs.length;
    const result = await runCli(['update', 'demo', '--version', '0.4.0', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('ion-drive update other');
    expect(result.stdout).toContain('--with-deps');
    expect(state.installs.length).toBe(installsBefore); // nothing installed
  }, 120_000);

  it('performs the chain with --with-deps: dependency first, then the target', async () => {
    const installsBefore = state.installs.length;
    const result = await runCli(['update', 'demo', '--version', '0.4.0', '--yes', '--with-deps']);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const chain = state.installs.slice(installsBefore).map((i) => `${i.name}@${i.version}`);
    expect(chain).toEqual(['other@2.0.0', 'demo@0.4.0']);

    const config = JSON.parse(readFileSync(join(project, 'ion.config.json'), 'utf8')) as {
      blocks: { name: string; version: string }[];
    };
    expect(config.blocks.find((b) => b.name === 'other')?.version).toBe('2.0.0');
    expect(config.blocks.find((b) => b.name === 'demo')?.version).toBe('0.4.0');
  }, 180_000);

  it('keeps --json stdout machine-pure (rule 7)', async () => {
    // demo is at 0.4.0 after the chain — the up-to-date result must still be
    // pure JSON on stdout, with any human chatter routed to stderr.
    const result = await runCli(['update', 'demo', '--version', '0.4.0', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toEqual({ updated: 'demo', version: '0.4.0', upToDate: true });
  }, 120_000);
});
