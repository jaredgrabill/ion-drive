/**
 * Unit tests for the `ion-drive init` project scaffold: file set, secure env
 * generation, barrel markers, and never-clobber semantics. (The full boot of a
 * scaffolded project against workspace tarballs is exercised by the Phase 14
 * live loop; CI-automating it is tracked in docs/roadmap.md.)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPgPort, scaffoldProject } from './project-scaffold.js';
import { isProjectDir } from './project.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-cli-scaffold-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scaffoldProject', () => {
  it('writes a complete, bootable project shape', () => {
    const result = scaffoldProject(dir);
    expect(result.created).toEqual(
      expect.arrayContaining([
        'package.json',
        'tsconfig.json',
        'server.ts',
        'blocks/index.ts',
        '.env',
        '.env.example',
        'docker-compose.yml',
        '.gitignore',
        '.github/workflows/ci.yml',
        'README.md',
        'AGENTS.md',
        '.claude/skills/ion-schema-change/SKILL.md',
        '.claude/skills/ion-add-block/SKILL.md',
      ]),
    );
    expect(result.skipped).toEqual([]);
    // The scaffold is a detectable framework project (dev-mode switch).
    expect(isProjectDir(dir)).toBe(true);
  });

  it('generates per-project secrets and pins @ion-drive deps to the release train', () => {
    scaffoldProject(dir);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    const keys = [...env.matchAll(/ION_(?:ENCRYPTION_KEY|AUTH_SECRET)=([0-9a-f]{64})/g)];
    expect(keys.length).toBe(2);
    expect(keys[0]?.[1]).not.toBe(keys[1]?.[1]);

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@ion-drive/core']).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['@ion-drive/admin']).toBe(pkg.dependencies['@ion-drive/core']);
  });

  it('enforces RBAC by default in the generated .env (audit V1)', () => {
    scaffoldProject(dir);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    // A fresh project is authenticated out of the box — not an open server.
    expect(env).toMatch(/^ION_REQUIRE_AUTH=true$/m);
    // The example file documents the safe default and the open-mode escape hatch.
    const example = readFileSync(join(dir, '.env.example'), 'utf8');
    expect(example).toMatch(/^ION_REQUIRE_AUTH=true$/m);
    expect(example).toContain('ION_ALLOW_OPEN');
  });

  it('scaffolds project CI with the audit step and a weekly schedule (spec-06)', () => {
    scaffoldProject(dir);
    const ci = readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('npx ion-drive audit');
    expect(ci).toContain('npx tsc --noEmit');
    expect(ci).toMatch(/schedule:\n\s+#[^\n]*\n\s+- cron:/);
    // AGENTS.md teaches agents the audit loop too.
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('ion-drive audit');
  });

  it('teaches agents block discovery: search + the four registry MCP tools (spec-08)', () => {
    scaffoldProject(dir);
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('## Finding blocks');
    expect(agents).toContain('ion-drive search');
    for (const tool of ['search_blocks', 'get_block', 'list_registries', 'preview_install']) {
      expect(agents).toContain(tool);
    }
    // The ion-add-block skill's discovery step mentions them too.
    const skill = readFileSync(join(dir, '.claude', 'skills', 'ion-add-block', 'SKILL.md'), 'utf8');
    expect(skill).toContain('ion-drive search');
    expect(skill).toContain('ion-drive mcp');
  });

  it('writes a barrel with the add/remove markers', () => {
    scaffoldProject(dir);
    const barrel = readFileSync(join(dir, 'blocks', 'index.ts'), 'utf8');
    expect(barrel).toContain('// ion-drive:imports');
    expect(barrel).toContain('// ion-drive:blocks');
  });

  it('parameterizes the Postgres host port with ION_PG_PORT as the single knob (#12)', () => {
    scaffoldProject(dir);
    // Compose interpolates the var (with the conventional default) from .env.
    const compose = readFileSync(join(dir, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain("'${ION_PG_PORT:-5432}:5432'");
    expect(compose).not.toMatch(/^\s+- '5432:5432'/m);
    // .env sets the knob and the database URL references it (no second copy
    // of the port to keep in sync by hand).
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toMatch(/^ION_PG_PORT=5432$/m);
    expect(env).toMatch(
      /^ION_DATABASE_URL=postgresql:\/\/ion:ion@localhost:\$\{ION_PG_PORT\}\/ion_drive$/m,
    );
    expect(readFileSync(join(dir, '.env.example'), 'utf8')).toMatch(/^ION_PG_PORT=5432$/m);
    // server.ts expands the placeholder (dotenv files don't interpolate).
    const server = readFileSync(join(dir, 'server.ts'), 'utf8');
    expect(server).toContain("replaceAll(\n    '${ION_PG_PORT}',");
    expect(server).toContain("process.env.ION_PG_PORT ?? '5432'");
  });

  it('writes a caller-chosen Postgres port into .env only (compose default stays 5432)', () => {
    scaffoldProject(dir, { pgPort: 55432 });
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toMatch(/^ION_PG_PORT=55432$/m);
    // The URL still goes through the placeholder — one knob, even when remapped.
    expect(env).toContain('localhost:${ION_PG_PORT}/ion_drive');
    const compose = readFileSync(join(dir, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain("'${ION_PG_PORT:-5432}:5432'");
  });

  it('never clobbers existing files', () => {
    scaffoldProject(dir);
    writeFileSync(join(dir, 'server.ts'), '// customized\n', 'utf8');
    const rerun = scaffoldProject(dir);
    expect(rerun.created).toEqual([]);
    expect(rerun.skipped).toContain('server.ts');
    expect(readFileSync(join(dir, 'server.ts'), 'utf8')).toBe('// customized\n');
  });
});

describe('detectPgPort', () => {
  /**
   * Occupies an ephemeral port on the IPv4 loopback — the same shape as a
   * native Postgres with the default `listen_addresses = 'localhost'`.
   */
  function occupyPort(): Promise<{ port: number; server: Server }> {
    return new Promise((resolvePromise) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolvePromise({ port, server });
      });
    });
  }

  it('returns the preferred port when it is free', async () => {
    const { port, server } = await occupyPort();
    await new Promise((r) => server.close(r));
    await expect(detectPgPort(port)).resolves.toBe(port);
  });

  it('skips a busy preferred port and picks a free fallback', async () => {
    const { port, server } = await occupyPort();
    try {
      const picked = await detectPgPort(port);
      expect(picked).not.toBe(port);
      expect(picked).toBeGreaterThan(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
