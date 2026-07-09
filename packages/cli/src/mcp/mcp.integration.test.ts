/**
 * Integration test for `ion-drive mcp` (spec-08 §4 / AC4's live half): a
 * stock MCP SDK client speaks stdio to the real CLI process (`node --import
 * tsx src/index.ts mcp`) against a protocol-v1 fixture registry served from
 * `node:http` on 127.0.0.1 (the `fixture-registry.test.ts` precedent).
 * Round-trips `search_blocks` → `get_block` (README inlined) →
 * `preview_install` (digest-verified plan; unreachable-server warning) and
 * `list_registries`. Needs no Postgres — only a free ephemeral port.
 *
 * The child runs with cwd = the CLI package (so `tsx` resolves) and
 * `ION_DRIVE_REGISTRY` pointing the built-in `@ion` at the fixture — the
 * documented CI/dev escape hatch. STDOUT purity is implicitly asserted: any
 * non-protocol stdout bytes would break the SDK client's framing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDigest, packBytes } from '../registry/verify.js';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- Fixture registry --------------------------------------------------------

const CRM_MANIFEST = { name: 'crm', version: '0.2.0', title: 'CRM', objects: [] };
const INVOICING_MANIFEST = {
  name: 'invoicing',
  version: '0.3.0',
  title: 'Invoicing',
  dependencies: { crm: '^0.2.0' },
  objects: [],
};
const CRM_BYTES = packBytes(CRM_MANIFEST);
const INVOICING_BYTES = packBytes(INVOICING_MANIFEST);
const README = '# Invoicing\n\nStripe payment links for invoices.\n';

const versionEntry = (name: string, version: string, bytes: Uint8Array) => ({
  artifactUrl: `../../${name}/dist/${version}/block.json`,
  digest: computeDigest(bytes),
  size: bytes.byteLength,
  publishedAt: '2026-07-09T00:00:00Z',
  dependencies: name === 'invoicing' ? { crm: '^0.2.0' } : {},
  requires: {},
  status: 'active',
});

function fixtureRoutes(): Record<string, Uint8Array | object> {
  return {
    '/registry/index.json': {
      schemaVersion: 1,
      name: 'MCP Fixture Registry',
      generatedAt: '2026-07-09T00:00:00Z',
      searchUrl: 'search-index.json',
      blocks: {
        crm: { title: 'CRM', latest: '0.2.0', blockUrl: 'blocks/crm.json' },
        invoicing: {
          title: 'Invoicing',
          description: 'Invoices and Stripe payment links.',
          latest: '0.3.0',
          blockUrl: 'blocks/invoicing.json',
        },
      },
    },
    '/registry/search-index.json': {
      schemaVersion: 1,
      generatedAt: '2026-07-09T00:00:00Z',
      documents: [
        { name: 'crm', title: 'CRM', latest: '0.2.0' },
        {
          name: 'invoicing',
          title: 'Invoicing',
          description: 'Invoices and Stripe payment links.',
          latest: '0.3.0',
        },
      ],
    },
    '/registry/blocks/crm.json': {
      schemaVersion: 1,
      name: 'crm',
      latest: '0.2.0',
      versions: { '0.2.0': versionEntry('crm', '0.2.0', CRM_BYTES) },
      advisories: [],
    },
    '/registry/blocks/invoicing.json': {
      schemaVersion: 1,
      name: 'invoicing',
      readmeUrl: 'invoicing.readme.md',
      latest: '0.3.0',
      versions: { '0.3.0': versionEntry('invoicing', '0.3.0', INVOICING_BYTES) },
      advisories: [],
    },
    '/registry/blocks/invoicing.readme.md': new TextEncoder().encode(README),
    '/crm/dist/0.2.0/block.json': CRM_BYTES,
    '/invoicing/dist/0.3.0/block.json': INVOICING_BYTES,
  };
}

let httpServer: Server;
let indexUrl: string;
let cacheDir: string;
let projectDir: string;
let client: Client;
let transport: StdioClientTransport;

/** Parses the single JSON text content block every tool returns. */
function parseResult(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  const text = content.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  const routes = fixtureRoutes();
  httpServer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body = routes[path];
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    if (body instanceof Uint8Array) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(body));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body, null, 2));
  });
  await new Promise<void>((resolveListen) =>
    httpServer.listen(0, '127.0.0.1', () => resolveListen()),
  );
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('no fixture port');
  indexUrl = `http://127.0.0.1:${address.port}/registry/index.json`;

  cacheDir = mkdtempSync(join(tmpdir(), 'ion-mcp-it-cache-'));

  // A scratch project as the child's cwd: @ion pinned to the fixture and a
  // deliberately dead serverUrl, so a developer's real server on :3000 can
  // never leak installed-block state into the plan.
  projectDir = mkdtempSync(join(tmpdir(), 'ion-mcp-it-project-'));
  writeFileSync(
    join(projectDir, 'ion.config.json'),
    `${JSON.stringify(
      { serverUrl: 'http://127.0.0.1:59999', registries: { '@ion': indexUrl }, blocks: [] },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // tsx by absolute file URL — the child's cwd is the scratch project, where
  // a bare `--import tsx` would not resolve.
  const tsxUrl = pathToFileURL(createRequire(join(CLI_DIR, 'package.json')).resolve('tsx')).href;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', tsxUrl, join(CLI_DIR, 'src', 'index.ts'), 'mcp'],
    cwd: projectDir,
    env: {
      ...(process.env as Record<string, string>),
      ION_DRIVE_CACHE_DIR: cacheDir, // isolate the disk cache
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'spec-08-integration', version: '0.0.0' });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  await new Promise<void>((resolveClose) => httpServer?.close(() => resolveClose()));
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('ion-drive mcp over stdio (stock MCP client)', () => {
  it('lists the four registry tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_block',
      'list_registries',
      'preview_install',
      'search_blocks',
    ]);
  });

  it('search_blocks finds invoicing via the fixture search index', async () => {
    const payload = parseResult(
      await client.callTool({ name: 'search_blocks', arguments: { term: 'invoi' } }),
    );
    expect(payload.source).toBe('search-index');
    expect((payload.hits as { name: string }[]).map((h) => h.name)).toEqual(['invoicing']);
  });

  it('get_block returns the version history with the README inlined', async () => {
    const payload = parseResult(
      await client.callTool({ name: 'get_block', arguments: { name: 'invoicing' } }),
    );
    expect(payload.block).toMatchObject({ name: 'invoicing', latest: '0.3.0' });
    expect(payload.readme).toBe(README);
  });

  it('list_registries shows @ion pointing at the fixture', async () => {
    const rows = parseResult(
      await client.callTool({ name: 'list_registries', arguments: {} }),
    ) as unknown as { namespace: string; url: string; blocks?: number }[];
    // A bare array parses to an array — normalize.
    const list = Array.isArray(rows) ? rows : [rows];
    const ion = list.find((r) => r.namespace === '@ion');
    expect(ion?.url).toBe(indexUrl);
    expect(ion?.blocks).toBe(2);
  });

  it('preview_install round-trips the verified dependency plan without changes', async () => {
    const payload = parseResult(
      await client.callTool({ name: 'preview_install', arguments: { ref: 'invoicing' } }),
    );
    expect(payload.changesApplied).toBe(false);
    const plan = payload.plan as { name: string; version: string; digest: string; tier: string }[];
    expect(plan.map((p) => `${p.name}@${p.version}`)).toEqual(['crm@0.2.0', 'invoicing@0.3.0']);
    expect(plan[1]?.digest).toBe(computeDigest(INVOICING_BYTES));
    expect(plan.every((p) => p.tier === 'community')).toBe(true); // unattested fixture
    // No server is running at the default serverUrl — the documented warning.
    expect((payload.warnings as string[]).join(' ')).toMatch(/unreachable/);
  });

  it('an unknown ref surfaces as a friendly tool error, not a crash', async () => {
    const result = (await client.callTool({
      name: 'preview_install',
      arguments: { ref: 'nonexistent-block' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown block/);
  });
});
