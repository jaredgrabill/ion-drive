/**
 * Unit tests for `ion-drive block publish` (spec-05 §2): repo-ref precedence,
 * validate-before-clone, the --pr vs --direct command sequences (stubbed
 * runner), PR-body rendering, the gh-ENOENT friendly error, and --dry-run
 * stopping after the temp-dir build.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCoreValidator } from '../registry/core-loader.js';
import { computeDigest, packBytes } from '../registry/verify.js';
import {
  type CommandRunner,
  GH_MISSING_MESSAGE,
  PROVENANCE_NOTE,
  blockPublishCommand,
  createCommandRunner,
  renderPublishBody,
} from './block.js';

let dir: string;
let cwd: string;
let logged: string[];

/** Everything printed, ANSI-stripped and joined. */
function output(): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return logged.join('\n').replace(/\[[0-9;]*m/g, '');
}

const MANIFEST = {
  name: 'billing',
  version: '1.0.0',
  title: 'Billing',
  dependencies: { crm: '^0.2.0' },
  requires: { core: '>=0.2.0 <1.0.0' },
  meta: { publishConfig: { registryRepo: 'acme/registry-from-manifest' } },
};

function writeBlockSource(manifest: Record<string, unknown> = MANIFEST): string {
  const blockDir = join(dir, 'block-billing');
  mkdirSync(blockDir, { recursive: true });
  writeFileSync(join(blockDir, 'block.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return blockDir;
}

/**
 * A stubbed runner that records every invocation and materializes the clone
 * directory (with a registry.config.json) when the clone command runs, so the
 * in-process `registry build` that follows has a real repo to work in.
 */
function stubRunner() {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const runner: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    // git: `clone --depth 1 <remote> <dir>`; gh: `repo clone <repo> <dir> -- --depth 1`.
    if (cmd === 'git' && args[0] === 'clone') return materializeClone(args[4]);
    if (cmd === 'gh' && args[1] === 'clone') return materializeClone(args[3]);
    if (cmd === 'git' && args[0] === 'status') return { stdout: ' A billing/block.json\n' };
    if (cmd === 'gh' && args[0] === 'pr') {
      return { stdout: 'https://github.com/acme/registry/pull/7\n' };
    }
    return { stdout: '' };
  };
  return { runner, calls };
}

/** Creates the "cloned" registry repo (with a registry.config.json) on disk. */
function materializeClone(cloneDir: string | undefined): { stdout: string } {
  if (!cloneDir) throw new Error('test: no clone dir in args');
  mkdirSync(cloneDir, { recursive: true });
  writeFileSync(
    join(cloneDir, 'registry.config.json'),
    `${JSON.stringify({ name: 'Acme Registry' }, null, 2)}\n`,
    'utf8',
  );
  return { stdout: '' };
}

// blockPublishCommand's first call pays the one-time dynamic import of the
// full @ion-drive/core barrel — ~6s cold on CI runners when core's dist/ is
// built (release.yml builds before testing; ci.yml doesn't, so the loader
// returns null there and the cost never shows). Warm it once so individual
// tests keep the default timeout.
beforeAll(async () => {
  await loadCoreValidator();
}, 30_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-publish-test-'));
  cwd = process.cwd();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('renderPublishBody', () => {
  it('renders version, digest, dep table, and the provenance note', () => {
    const body = renderPublishBody({
      name: 'billing',
      version: '1.0.0',
      digest: 'sha256:abc',
      size: 1234,
      dependencies: { crm: '^0.2.0' },
      requiresCore: '>=0.2.0 <1.0.0',
    });
    expect(body).toContain('Publish `billing@1.0.0`');
    expect(body).toContain('| Digest | `sha256:abc` |');
    expect(body).toContain('| crm | `^0.2.0` |');
    expect(body).toContain('| Requires core | `>=0.2.0 <1.0.0` |');
    expect(body).toContain(PROVENANCE_NOTE);
  });

  it('renders "_none_" for an empty dependency table', () => {
    const body = renderPublishBody({
      name: 'x',
      version: '0.1.0',
      digest: 'sha256:d',
      size: 1,
      dependencies: {},
    });
    expect(body).toContain('_none_');
  });
});

describe('blockPublishCommand', () => {
  it('errors without a target repo when the manifest has no publishConfig', async () => {
    const blockDir = writeBlockSource({ name: 'billing', version: '1.0.0', title: 'Billing' });
    const { runner, calls } = stubRunner();
    await blockPublishCommand(blockDir, { runner, json: true });
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('--registry-repo');
    expect(calls).toEqual([]); // failed before any clone
  });

  it('fails validation before cloning anything', async () => {
    const blockDir = writeBlockSource({ ...MANIFEST, version: 'v1.0.0' });
    const { runner, calls } = stubRunner();
    await blockPublishCommand(blockDir, { runner });
    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  it('--pr (default): gh clone → branch → add/commit → push → gh pr create with the body', async () => {
    const blockDir = writeBlockSource();
    const { runner, calls } = stubRunner();
    await blockPublishCommand(blockDir, { runner, registryRepo: 'acme/registry' });
    expect(process.exitCode).toBeUndefined();

    const sequence = calls.map((call) => `${call.cmd} ${call.args.slice(0, 2).join(' ')}`);
    expect(sequence).toEqual([
      'gh repo clone',
      'git checkout -b',
      'git add -A',
      'git status --porcelain',
      'git commit -m',
      'git push -u',
      'gh pr create',
    ]);
    // Flag beats the manifest's publishConfig.
    expect(calls[0]?.args).toContain('acme/registry');
    expect(calls[1]?.args[2]).toBe('publish/billing-1.0.0');
    expect(calls[4]?.args[2]).toBe('publish: billing@1.0.0');
    const prArgs = calls[6]?.args ?? [];
    const body = prArgs[prArgs.indexOf('--body') + 1] ?? '';
    expect(body).toContain(PROVENANCE_NOTE);
    expect(body).toContain(computeDigest(packBytes(JSON.parse(JSON.stringify(MANIFEST)))));
    expect(output()).toContain('https://github.com/acme/registry/pull/7');
    expect(output()).toContain(PROVENANCE_NOTE);
  });

  it('falls back to meta.publishConfig.registryRepo when no flag is given', async () => {
    const blockDir = writeBlockSource();
    const { runner, calls } = stubRunner();
    await blockPublishCommand(blockDir, { runner });
    expect(calls[0]?.args).toContain('acme/registry-from-manifest');
  });

  it('--direct: plain git clone + push to the default branch, no gh anywhere', async () => {
    const blockDir = writeBlockSource();
    const { runner, calls } = stubRunner();
    await blockPublishCommand(blockDir, { runner, registryRepo: 'acme/registry', direct: true });
    expect(process.exitCode).toBeUndefined();

    const sequence = calls.map((call) => `${call.cmd} ${call.args.slice(0, 2).join(' ')}`);
    expect(sequence).toEqual([
      'git clone --depth',
      'git add -A',
      'git status --porcelain',
      'git commit -m',
      'git push origin',
    ]);
    expect(calls.every((call) => call.cmd !== 'gh')).toBe(true);
    // owner/repo expands to the https remote for plain git.
    expect(calls[0]?.args).toContain('https://github.com/acme/registry.git');
  });

  it('--dry-run stops after the temp-dir build: no commit, no push, no PR', async () => {
    const blockDir = writeBlockSource();
    const { runner, calls } = stubRunner();
    await blockPublishCommand(blockDir, {
      runner,
      registryRepo: 'acme/registry',
      dryRun: true,
      json: true,
    });
    expect(process.exitCode).toBeUndefined();
    expect(calls.map((call) => call.cmd + call.args[0])).toEqual(['ghrepo']); // clone only
    const payload = JSON.parse(output()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      block: 'billing',
      version: '1.0.0',
      dryRun: true,
      mode: 'pr',
      provenanceNote: PROVENANCE_NOTE,
    });
    expect(String(payload.digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('surfaces registry build refusals from the clone and aborts', async () => {
    const blockDir = writeBlockSource();
    // A clone without registry.config.json → the build refuses.
    const calls: { cmd: string }[] = [];
    const runner: CommandRunner = async (cmd, args) => {
      calls.push({ cmd });
      if (cmd === 'gh' && args[1] === 'clone') {
        mkdirSync(args[3] ?? '', { recursive: true });
        return { stdout: '' };
      }
      return { stdout: '' };
    };
    await blockPublishCommand(blockDir, { runner, registryRepo: 'acme/registry' });
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('registry.config.json is missing');
    expect(calls).toHaveLength(1); // nothing after the clone
  });
});

describe('createCommandRunner', () => {
  it('maps a gh ENOENT to the friendly install-or-use---direct message', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const runner = createCommandRunner((_cmd, _args, _opts, callback) => callback(enoent, '', ''));
    await expect(runner('gh', ['repo', 'clone'])).rejects.toThrow(GH_MISSING_MESSAGE);
  });

  it('keeps other failures verbatim with stderr detail', async () => {
    const failed = Object.assign(new Error('exit 128'), { code: 128 });
    const runner = createCommandRunner((_cmd, _args, _opts, callback) =>
      callback(failed, '', 'fatal: not a repository'),
    );
    await expect(runner('git', ['push'])).rejects.toThrow(/git push.*fatal: not a repository/);
  });
});
