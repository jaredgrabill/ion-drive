/**
 * Unit tests for the `ion-drive init` project scaffold: file set, secure env
 * generation, barrel markers, and never-clobber semantics. (The full boot of a
 * scaffolded project against workspace tarballs is exercised by the Phase 14
 * live loop; CI-automating it is tracked in docs/roadmap.md.)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldProject } from './project-scaffold.js';
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

  it('writes a barrel with the add/remove markers', () => {
    scaffoldProject(dir);
    const barrel = readFileSync(join(dir, 'blocks', 'index.ts'), 'utf8');
    expect(barrel).toContain('// ion-drive:imports');
    expect(barrel).toContain('// ion-drive:blocks');
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
