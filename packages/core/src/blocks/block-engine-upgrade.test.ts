/**
 * Unit tests for the engine's upgrade gates (spec-07) against a stubbed
 * ledger store + installer: not-installed, equal-version no-op vs 409
 * (digest-compared and delta-fallback), downgrade refusal, snapshot-parse
 * recovery, the created_objects ownership math, and the failure path that
 * preserves prior ownership (AC4) — including the install() fix.
 */

import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { DataService } from '../data/data-service.js';
import type { SystemDatabase } from '../db/types.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import type { BlockInstaller } from './block-installer.js';
import { BlockInstallError } from './block-installer.js';
import { parseManifest } from './block-manifest.js';
import type { BlockInstallReport, BlockManifest, InstalledBlock } from './block-types.js';
import { BlockEngine, BlockEngineError } from './index.js';

const schemaManager = {
  getObject: () => undefined,
  registry: { getRelationships: () => [] },
} as unknown as SchemaManager;

function manifest(version: string, extra: Record<string, unknown> = {}): BlockManifest {
  return parseManifest({ name: 'demo', version, title: 'Demo', ...extra });
}

function installedRow(version: string, overrides: Partial<InstalledBlock> = {}): InstalledBlock {
  return {
    name: 'demo',
    version,
    title: 'Demo',
    status: 'installed',
    createdObjects: ['contacts', 'notes'],
    manifest: manifest(version),
    artifactDigest: null,
    sourceRegistry: null,
    sourceUrl: null,
    publisher: null,
    attested: null,
    trustTier: null,
    installedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** An engine whose store + installer are in-memory stubs. */
function buildEngine(existing: InstalledBlock | undefined) {
  const engine = new BlockEngine({} as Kysely<SystemDatabase>, {
    schemaManager,
    dataService: {} as DataService,
  });
  const finishes: { name: string; status: string; createdObjects: string[] }[] = [];
  const statusFlips: string[] = [];
  const replacements: { version: string; createdObjects: string[] }[] = [];
  Object.assign(engine.store, {
    getByName: async () => existing,
    listInstalledVersions: async () =>
      new Map(existing ? [[existing.name, existing.version] as const] : []),
    begin: async () => undefined,
    finish: async (name: string, status: string, createdObjects: string[]) => {
      finishes.push({ name, status, createdObjects });
    },
    // Upgrade semantics (AC4): only the status flips until success replaces
    // the snapshot — the stubs record both halves for the assertions below.
    setStatus: async (_name: string, status: string) => {
      statusFlips.push(status);
    },
    replaceInstalled: async (m: BlockManifest, createdObjects: string[]) => {
      replacements.push({ version: m.version, createdObjects });
    },
  });
  const installerStub = {
    upgrade: vi.fn(
      async (): Promise<BlockInstallReport> => ({
        block: 'demo',
        version: '0.3.0',
        dryRun: false,
        objectsCreated: ['deals'],
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
        warnings: [],
      }),
    ),
    install: vi.fn(async () => {
      throw new BlockInstallError('boom');
    }),
  };
  (engine as unknown as { installer: BlockInstaller }).installer =
    installerStub as unknown as BlockInstaller;
  return { engine, finishes, statusFlips, replacements, installerStub };
}

describe('BlockEngine.upgrade — version gates', () => {
  it('404s when the block is not installed, pointing at install', async () => {
    const { engine } = buildEngine(undefined);
    const run = engine.upgrade(manifest('0.3.0'));
    await expect(run).rejects.toMatchObject({ code: 'not_found' });
    await expect(engine.upgrade(manifest('0.3.0'))).rejects.toThrowError(/plain install/);
  });

  it('answers an equal version with matching digests as a no-op report', async () => {
    const { engine, installerStub } = buildEngine(
      installedRow('0.2.0', { artifactDigest: `sha256:${'a'.repeat(64)}` }),
    );
    const report = await engine.upgrade(manifest('0.2.0'), {
      source: { digest: `sha256:${'a'.repeat(64)}` },
    });
    expect(report.upgraded).toEqual({ from: '0.2.0', to: '0.2.0' });
    expect(report.warnings[0]).toContain('nothing to do');
    expect(installerStub.upgrade).not.toHaveBeenCalled();
  });

  it('409s an equal version with a different digest, naming the force-reinstall path', async () => {
    const { engine } = buildEngine(
      installedRow('0.2.0', { artifactDigest: `sha256:${'a'.repeat(64)}` }),
    );
    const run = engine.upgrade(manifest('0.2.0'), {
      source: { digest: `sha256:${'b'.repeat(64)}` },
    });
    await expect(run).rejects.toMatchObject({ code: 'not_an_upgrade' });
    await expect(
      engine.upgrade(manifest('0.2.0'), { source: { digest: `sha256:${'b'.repeat(64)}` } }),
    ).rejects.toThrowError(/--force/);
  });

  it('falls back to the structural delta when digests are missing', async () => {
    const noop = await buildEngine(installedRow('0.2.0')).engine.upgrade(manifest('0.2.0'));
    expect(noop.warnings[0]).toContain('nothing to do');

    const changed = manifest('0.2.0', {
      objects: [
        {
          name: 'contacts',
          displayName: 'Contacts',
          fields: [{ name: 'email', displayName: 'Email', columnType: 'email' }],
        },
      ],
    });
    await expect(buildEngine(installedRow('0.2.0')).engine.upgrade(changed)).rejects.toMatchObject({
      code: 'not_an_upgrade',
    });
  });

  it('refuses a downgrade with the documented remove-then-add recovery', async () => {
    const { engine } = buildEngine(installedRow('0.3.0'));
    const run = engine.upgrade(manifest('0.2.0'));
    await expect(run).rejects.toMatchObject({ code: 'not_an_upgrade' });
    await expect(engine.upgrade(manifest('0.2.0'))).rejects.toThrowError(
      /ion-drive remove demo.*ion-drive add demo@0\.2\.0/,
    );
  });

  it('rejects an undiffable (pre-v1) snapshot with the uninstall+reinstall recovery', async () => {
    const broken = installedRow('0.2.0', {
      manifest: { name: 'demo', dependencies: ['crm'] } as unknown as BlockManifest,
    });
    const { engine } = buildEngine(broken);
    const run = engine.upgrade(manifest('0.3.0'));
    await expect(run).rejects.toMatchObject({ code: 'validation' });
    await expect(engine.upgrade(manifest('0.3.0'))).rejects.toThrowError(/ion-drive remove demo/);
  });
});

describe('BlockEngine.upgrade — ledger ownership math', () => {
  it('finishes with (existing ∪ created) − removed', async () => {
    const { engine, finishes } = buildEngine(installedRow('0.2.0'));
    // The new manifest keeps contacts, drops notes (structural delta), and the
    // stubbed installer reports one newly created object ("deals").
    const next = manifest('0.3.0', {
      objects: [
        {
          name: 'contacts',
          displayName: 'Contacts',
          fields: [{ name: 'email', displayName: 'Email', columnType: 'email' }],
        },
      ],
    });
    // Give the old snapshot both objects so "notes" lands in delta.objects.removed.
    const old = installedRow('0.2.0', {
      manifest: manifest('0.2.0', {
        objects: [
          {
            name: 'contacts',
            displayName: 'Contacts',
            fields: [{ name: 'email', displayName: 'Email', columnType: 'email' }],
          },
          {
            name: 'notes',
            displayName: 'Notes',
            fields: [{ name: 'body', displayName: 'Body', columnType: 'text' }],
          },
        ],
      }),
    });
    const withOld = buildEngine(old);
    await withOld.engine.upgrade(next);
    // Success is a snapshot replacement (begin-with-old/finish-with-new):
    // status flipped to installing first, then the new manifest + merged
    // ownership landed atomically via replaceInstalled.
    expect(withOld.statusFlips).toEqual(['installing']);
    expect(withOld.replacements).toEqual([
      { version: '0.3.0', createdObjects: ['contacts', 'deals'] },
    ]);
    expect(withOld.finishes).toEqual([]); // upgrades never use plain finish
    expect(finishes).toEqual([]); // the first engine was never driven
  });

  it('a mid-way failure only flips status — prior version/snapshot/ownership stay (AC4)', async () => {
    const old = installedRow('0.2.0', {
      manifest: manifest('0.2.0', {
        objects: [
          {
            name: 'contacts',
            displayName: 'Contacts',
            fields: [{ name: 'email', displayName: 'Email', columnType: 'email' }],
          },
        ],
      }),
    });
    const { engine, finishes, statusFlips, replacements, installerStub } = buildEngine(old);
    installerStub.upgrade.mockRejectedValueOnce(new BlockInstallError('step 3 exploded'));
    await expect(engine.upgrade(manifest('0.3.0'))).rejects.toThrowError(BlockEngineError);
    // The row was never rewritten — the 0.2.0 snapshot remains the diff
    // anchor a re-run needs; only the status moved installing → failed.
    expect(statusFlips).toEqual(['installing', 'failed']);
    expect(replacements).toEqual([]);
    expect(finishes).toEqual([]);
  });

  it('a fixed-cause re-run of the SAME upgrade completes (AC4 re-run)', async () => {
    const old = installedRow('0.2.0', {
      status: 'failed', // left behind by the failed attempt above
      manifest: manifest('0.2.0', {
        objects: [
          {
            name: 'contacts',
            displayName: 'Contacts',
            fields: [{ name: 'email', displayName: 'Email', columnType: 'email' }],
          },
        ],
      }),
    });
    const { engine, statusFlips, replacements, installerStub } = buildEngine(old);
    const next = manifest('0.3.0', {
      objects: [
        {
          name: 'contacts',
          displayName: 'Contacts',
          fields: [{ name: 'email', displayName: 'Email', columnType: 'email' }],
        },
      ],
    });
    const report = await engine.upgrade(next);
    // The preserved 0.2.0 anchor lets the gate pass (0.3.0 > 0.2.0) and the
    // idempotent installer finish the job.
    expect(installerStub.upgrade).toHaveBeenCalledTimes(1);
    expect(report.version).toBe('0.3.0');
    expect(statusFlips).toEqual(['installing']);
    expect(replacements).toEqual([
      { version: '0.3.0', createdObjects: ['contacts', 'notes', 'deals'] },
    ]);
  });

  it('never no-ops an equal-version request against a failed row', async () => {
    const { engine } = buildEngine(installedRow('0.2.0', { status: 'failed' }));
    const run = engine.upgrade(manifest('0.2.0'));
    await expect(run).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.upgrade(manifest('0.2.0'))).rejects.toThrowError(/--force/);
  });

  it('install() failure also preserves prior ownership (the fixed wipe-to-[])', async () => {
    const { engine, finishes } = buildEngine(installedRow('0.2.0'));
    await expect(engine.install(manifest('0.2.0'), { force: true })).rejects.toThrowError(
      BlockEngineError,
    );
    expect(finishes).toEqual([
      { name: 'demo', status: 'failed', createdObjects: ['contacts', 'notes'] },
    ]);
  });
});
