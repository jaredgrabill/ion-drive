/**
 * Unit tests for the pure halves of the update flow (spec-07): the six-way
 * code-file status matrix (byte comparisons against the ledger snapshot) and
 * target-version selection (exact / range / prerelease / status rules), plus
 * `applyCodeUpdates`' `.new`-file convention and path hardening.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VendorError, applyCodeUpdates } from '../project.js';
import { UpdateError, codeFileStatuses, selectTargetVersion } from './update-shared.js';

const f = (path: string, contents: string) => ({ path, contents });

describe('codeFileStatuses — the six-status matrix', () => {
  it('classifies every status from the three-way byte comparison', () => {
    const oldCode = [
      f('unchanged.ts', 'same\n'),
      f('updatable.ts', 'v1\n'),
      f('edited.ts', 'v1\n'),
      f('removed.ts', 'v1\n'),
    ];
    const newCode = [
      f('unchanged.ts', 'same\n'),
      f('updatable.ts', 'v2\n'),
      f('edited.ts', 'v2\n'),
      f('added.ts', 'fresh\n'),
    ];
    const tree = new Map([
      ['unchanged.ts', 'same\n'],
      ['updatable.ts', 'v1\n'], // pristine — safe overwrite
      ['edited.ts', 'my version\n'], // user-touched — never overwritten
      ['removed.ts', 'v1\n'],
      ['mine.ts', 'user-created\n'],
    ]);
    const statuses = new Map(
      codeFileStatuses(oldCode, newCode, tree).map((d) => [d.path, d.status]),
    );
    expect(statuses.get('unchanged.ts')).toBe('unchanged');
    expect(statuses.get('updatable.ts')).toBe('update-available');
    expect(statuses.get('edited.ts')).toBe('modified-by-you');
    expect(statuses.get('added.ts')).toBe('added-upstream');
    expect(statuses.get('removed.ts')).toBe('removed-upstream');
    expect(statuses.get('mine.ts')).toBe('yours');
  });

  it('treats a user-deleted vendored file as modified-by-you (never recreated over intent)', () => {
    const [status] = codeFileStatuses([f('a.ts', 'v1\n')], [f('a.ts', 'v2\n')], new Map());
    expect(status?.status).toBe('modified-by-you');
  });

  it('treats a tree already at the new bytes as unchanged (manual pre-apply)', () => {
    const [status] = codeFileStatuses(
      [f('a.ts', 'v1\n')],
      [f('a.ts', 'v2\n')],
      new Map([['a.ts', 'v2\n']]),
    );
    expect(status?.status).toBe('unchanged');
  });
});

describe('selectTargetVersion', () => {
  const versions = {
    '0.2.0': { status: 'active' },
    '0.3.0': { status: 'active' },
    '0.4.0-beta.1': { status: 'active' },
    '0.1.0': { status: 'deprecated', statusReason: 'superseded' },
    '0.2.5': { status: 'yanked' },
  };

  it('defaults to the highest active non-prerelease version', () => {
    expect(selectTargetVersion('demo', undefined, versions, '0.3.0')).toBe('0.3.0');
  });

  it('honors an exact active selector and rejects non-active ones by status', () => {
    expect(selectTargetVersion('demo', '0.2.0', versions, '0.3.0')).toBe('0.2.0');
    expect(() => selectTargetVersion('demo', '0.1.0', versions, '0.3.0')).toThrowError(
      /deprecated/,
    );
    expect(() => selectTargetVersion('demo', '9.9.9', versions, '0.3.0')).toThrowError(UpdateError);
  });

  it('resolves ranges over active versions; prereleases only when the selector demands', () => {
    expect(selectTargetVersion('demo', '>=0.2.0 <1.0.0', versions, '0.3.0')).toBe('0.3.0');
    expect(selectTargetVersion('demo', '^0.2.0', versions, '0.3.0')).toBe('0.2.0'); // 0.x caret pins the minor
    expect(selectTargetVersion('demo', '>=0.4.0-beta.0 <1.0.0', versions, '0.3.0')).toBe(
      '0.4.0-beta.1',
    );
    expect(() => selectTargetVersion('demo', 'not-a-range', versions, '0.3.0')).toThrowError(
      /not a version or semver range/,
    );
  });
});

describe('applyCodeUpdates — the .new convention + hardening', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('writes safe files, .new beside edited ones, and never touches yours', () => {
    root = mkdtempSync(join(tmpdir(), 'ion-apply-'));
    const blockDir = join(root, 'blocks', 'demo');
    mkdirSync(blockDir, { recursive: true });
    writeFileSync(join(blockDir, 'edited.ts'), 'my version\n', 'utf8');
    writeFileSync(join(blockDir, 'edited.ts.new'), 'stale\n', 'utf8'); // overwritten

    const result = applyCodeUpdates(
      'demo',
      [
        { path: 'safe.ts', status: 'update-available', newContents: 'v2\n' },
        { path: 'nested/added.ts', status: 'added-upstream', newContents: 'fresh\n' },
        { path: 'edited.ts', status: 'modified-by-you', oldContents: 'v1\n', newContents: 'v2\n' },
        { path: 'gone.ts', status: 'removed-upstream', oldContents: 'v1\n' },
        { path: 'mine.ts', status: 'yours' },
      ],
      root,
    );

    expect(result.written.sort()).toEqual(['blocks/demo/nested/added.ts', 'blocks/demo/safe.ts']);
    expect(result.newFiles).toEqual(['blocks/demo/edited.ts.new']);
    expect(result.removedUpstream).toEqual(['blocks/demo/gone.ts']);
    expect(readFileSync(join(blockDir, 'edited.ts'), 'utf8')).toBe('my version\n');
    expect(readFileSync(join(blockDir, 'edited.ts.new'), 'utf8')).toBe('v2\n');
    expect(readFileSync(join(blockDir, 'safe.ts'), 'utf8')).toBe('v2\n');
  });

  it('hardens every path — a traversal anywhere writes nothing at all', () => {
    root = mkdtempSync(join(tmpdir(), 'ion-apply-'));
    expect(() =>
      applyCodeUpdates(
        'demo',
        [
          { path: 'ok.ts', status: 'update-available', newContents: 'v2\n' },
          { path: '../escape.ts', status: 'added-upstream', newContents: 'evil\n' },
        ],
        root,
      ),
    ).toThrowError(VendorError);
    expect(() => readFileSync(join(root, 'blocks', 'demo', 'ok.ts'), 'utf8')).toThrow();
  });
});
