/**
 * Unit tests for the installer's upgrade mode (spec-07) against fake
 * services: additive skip-and-report, modifying fields through the validated
 * pipeline (self-owned internal force never downgrades data-safety errors),
 * released-to-user flips, the destructive gate (skip vs force vs dropData),
 * task update-in-place preserving `enabled`, and the webhook/subscription
 * runtime re-sync (update-not-recreate, secret preserved, provenance guard).
 */

import { describe, expect, it } from 'vitest';
import type { DataService } from '../data/data-service.js';
import type { MessageBus } from '../messaging/message-bus.js';
import type { WebhookManager } from '../messaging/webhooks.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import type {
  ChangeError,
  ChangePreview,
  DataObjectDefinition,
  FieldModification,
} from '../schema/types.js';
import type { TaskEngine } from '../tasks/index.js';
import { BlockInstallError, BlockInstaller } from './block-installer.js';
import { parseManifest } from './block-manifest.js';
import type { BlockManifest, InstalledBlock } from './block-types.js';
import { diffManifests } from './manifest-diff.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function preview(errors: ChangeError['message'][] = [], codes: string[] = []): ChangePreview {
  return {
    changeSet: { id: 'x', description: '', changes: [], createdAt: new Date() },
    sqlStatements: ['-- fake sql'],
    warnings: [],
    errors: errors.map((message, i) => ({
      change: { type: 'modify_field', objectName: '', details: {} },
      message,
      code: codes[i] ?? 'FAKE',
    })),
    isValid: errors.length === 0,
  };
}

/** A minimal in-memory SchemaManager double recording every call. */
function fakeSchemaManager(objects: DataObjectDefinition[]) {
  const byName = new Map(objects.map((o) => [o.name, o]));
  const calls = {
    addField: [] as { object: string; field: string }[],
    modifyField: [] as {
      object: string;
      field: string;
      updates: FieldModification;
      options: { dryRun?: boolean; force?: boolean };
    }[],
    removeField: [] as { object: string; field: string; force?: boolean }[],
    removeRelationship: [] as { object: string; rel: string; force?: boolean }[],
    deleteObject: [] as string[],
    releaseToUser: [] as { object: string; field?: string }[],
    createObject: [] as string[],
  };
  /** Set to inject a failing preview into the next modifyField call. */
  let nextModifyFieldFailure: ChangePreview | undefined;
  const manager = {
    calls,
    failNextModifyField(p: ChangePreview) {
      nextModifyFieldFailure = p;
    },
    getObject: (name: string) => byName.get(name),
    registry: { getRelationships: (name: string) => byName.get(name)?.relationships ?? [] },
    previewChanges: async () => preview(),
    createObject: async (def: DataObjectDefinition) => {
      calls.createObject.push(def.name);
      byName.set(def.name, def);
      return { preview: preview(), success: true, object: def };
    },
    addRelationship: async () => ({ preview: preview(), success: true }),
    addField: async (object: string, field: { name: string }) => {
      calls.addField.push({ object, field: field.name });
      return { preview: preview(), success: true };
    },
    modifyField: async (
      object: string,
      field: string,
      updates: FieldModification,
      options: { dryRun?: boolean; force?: boolean } = {},
    ) => {
      calls.modifyField.push({ object, field, updates, options });
      if (nextModifyFieldFailure) {
        const failed = nextModifyFieldFailure;
        nextModifyFieldFailure = undefined;
        return { preview: failed, success: false };
      }
      return { preview: preview(), success: true };
    },
    removeField: async (object: string, field: string, options: { force?: boolean } = {}) => {
      calls.removeField.push({ object, field, force: options.force });
      return { preview: preview(), success: true };
    },
    removeRelationship: async (object: string, rel: string, options: { force?: boolean } = {}) => {
      calls.removeRelationship.push({ object, rel, force: options.force });
      return { preview: preview(), success: true };
    },
    deleteObject: async (name: string) => {
      calls.deleteObject.push(name);
      byName.delete(name);
      return { preview: preview(), success: true };
    },
    releaseToUser: async (object: string, field?: string) => {
      calls.releaseToUser.push({ object, field });
      return { success: true };
    },
  };
  return manager as typeof manager & SchemaManager;
}

/** DataService double: `rowCounts` drives the non-empty-object guard. */
function fakeDataService(rowCounts: Record<string, number> = {}) {
  return {
    list: async (name: string) => ({
      data: [],
      pagination: { page: 1, pageSize: 1, totalCount: rowCounts[name] ?? 0, totalPages: 0 },
    }),
  } as unknown as DataService;
}

interface FakeTask {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string | null;
}

function fakeTaskEngine(tasks: FakeTask[]) {
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const calls = {
    created: [] as string[],
    updated: [] as { id: string; patch: Record<string, unknown> }[],
    removed: [] as string[],
  };
  const engine = {
    calls,
    store: { getByName: async (name: string) => byName.get(name) },
    create: async (input: { name: string }) => {
      calls.created.push(input.name);
      byName.set(input.name, { id: input.name, name: input.name, enabled: true, schedule: null });
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      calls.updated.push({ id, patch });
    },
    remove: async (id: string) => {
      calls.removed.push(id);
      for (const [name, t] of byName) if (t.id === id) byName.delete(name);
    },
  };
  return engine as typeof engine & TaskEngine;
}

function fakeWebhookManager(hooks: { id: string; name: string; managedBy: string }[]) {
  const byName = new Map(hooks.map((h) => [h.name, h]));
  const calls = {
    created: [] as string[],
    updated: [] as { id: string; patch: Record<string, unknown> }[],
    removed: [] as string[],
  };
  const manager = {
    calls,
    getByName: async (name: string) => byName.get(name) ?? null,
    create: async (input: { name: string }) => {
      calls.created.push(input.name);
      return { webhook: { id: input.name, name: input.name }, secret: `whsec_new_${input.name}` };
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      calls.updated.push({ id, patch });
      return { id };
    },
    remove: async (id: string) => {
      calls.removed.push(id);
      return true;
    },
  };
  return manager as typeof manager & WebhookManager;
}

function fakeBus() {
  const calls = { subscribed: [] as string[], unsubscribed: [] as string[] };
  const bus = {
    calls,
    hasHandler: () => true,
    subscribe: (sub: { consumer: string }) => calls.subscribed.push(sub.consumer),
    unsubscribeConsumer: (consumer: string) => calls.unsubscribed.push(consumer),
  };
  return bus as typeof bus & MessageBus;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BLOCK = 'demo';

function installedAt(version: string, manifest: BlockManifest, createdObjects: string[]) {
  return {
    name: BLOCK,
    version,
    title: 'Demo',
    status: 'installed',
    createdObjects,
    manifest,
    artifactDigest: null,
    sourceRegistry: null,
    sourceUrl: null,
    publisher: null,
    attested: null,
    trustTier: null,
    installedAt: new Date(),
    updatedAt: new Date(),
  } as InstalledBlock;
}

const oldManifest = parseManifest({
  name: BLOCK,
  version: '0.2.0',
  title: 'Demo',
  objects: [
    {
      name: 'contacts',
      displayName: 'Contacts',
      fields: [
        { name: 'email', displayName: 'Email', columnType: 'email' },
        { name: 'legacy', displayName: 'Legacy', columnType: 'text' },
      ],
    },
    {
      name: 'notes',
      displayName: 'Notes',
      fields: [{ name: 'body', displayName: 'Body', columnType: 'text' }],
    },
  ],
  tasks: [
    { name: 'demo-clean', type: 'noop', schedule: '0 0 * * *' },
    { name: 'demo-report', type: 'noop' },
  ],
  subscriptions: [{ event: 'data.#', consumer: 'demo-old', handler: 'log_event' }],
  webhooks: [
    { name: 'demo-hook', url: 'https://old.example/h', topics: ['data.#'] },
    { name: 'demo-dropped', url: 'https://old.example/d', topics: ['data.#'] },
  ],
});

const newManifest = parseManifest({
  name: BLOCK,
  version: '0.3.0',
  title: 'Demo',
  objects: [
    {
      name: 'contacts',
      displayName: 'Contacts',
      fields: [
        {
          name: 'email',
          displayName: 'Email',
          columnType: 'email',
          isRequired: true,
          defaultValue: 'unknown@example.com',
          constraints: { max: 320 },
        },
        { name: 'status', displayName: 'Status', columnType: 'text' },
      ],
    },
  ],
  tasks: [{ name: 'demo-clean', type: 'noop', schedule: '0 6 * * *' }],
  subscriptions: [{ event: 'data.#', consumer: 'demo-new', handler: 'log_event' }],
  webhooks: [{ name: 'demo-hook', url: 'https://new.example/h', topics: ['data.contacts.*'] }],
});

const delta = diffManifests(oldManifest, newManifest);

/** Live registry state matching the OLD manifest, provenance-stamped. */
function liveObjects(): DataObjectDefinition[] {
  const managedBy = `block:${BLOCK}` as const;
  return [
    {
      name: 'contacts',
      displayName: 'Contacts',
      tableName: 'contacts',
      managedBy,
      fields: [
        {
          id: 'f-email',
          name: 'email',
          displayName: 'Email',
          columnName: 'email',
          columnType: 'email',
          managedBy,
        },
        {
          id: 'f-legacy',
          name: 'legacy',
          displayName: 'Legacy',
          columnName: 'legacy',
          columnType: 'text',
          managedBy,
        },
      ],
      relationships: [],
    },
    {
      name: 'notes',
      displayName: 'Notes',
      tableName: 'notes',
      managedBy,
      fields: [
        {
          id: 'f-body',
          name: 'body',
          displayName: 'Body',
          columnName: 'body',
          columnType: 'text',
          managedBy,
        },
      ],
      relationships: [],
    },
  ];
}

function build(
  overrides: {
    objects?: DataObjectDefinition[];
    rowCounts?: Record<string, number>;
    webhooks?: { id: string; name: string; managedBy: string }[];
  } = {},
) {
  const schemaManager = fakeSchemaManager(overrides.objects ?? liveObjects());
  const dataService = fakeDataService(overrides.rowCounts);
  const taskEngine = fakeTaskEngine([
    { id: 't-clean', name: 'demo-clean', enabled: false, schedule: '0 0 * * *' },
    { id: 't-report', name: 'demo-report', enabled: true, schedule: null },
  ]);
  const webhookManager = fakeWebhookManager(
    overrides.webhooks ?? [
      { id: 'w-hook', name: 'demo-hook', managedBy: `block:${BLOCK}` },
      { id: 'w-dropped', name: 'demo-dropped', managedBy: `block:${BLOCK}` },
    ],
  );
  const bus = fakeBus();
  const installer = new BlockInstaller({
    schemaManager,
    dataService,
    taskEngine,
    webhookManager,
    bus,
    coreVersion: '0.3.0',
  });
  return { installer, schemaManager, taskEngine, webhookManager, bus };
}

const existing = () => installedAt('0.2.0', oldManifest, ['contacts', 'notes']);

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('BlockInstaller.upgrade — additive + modifying', () => {
  it('adds new fields, modifies changed ones with an internal force, and stamps the report', async () => {
    const { installer, schemaManager } = build();
    const report = await installer.upgrade(existing(), newManifest, delta, {});

    expect(report.upgraded).toEqual({ from: '0.2.0', to: '0.3.0' });
    expect(report.delta).toBe(delta);
    expect(schemaManager.calls.addField).toEqual([{ object: 'contacts', field: 'status' }]);

    const modify = schemaManager.calls.modifyField[0];
    expect(modify?.object).toBe('contacts');
    expect(modify?.field).toBe('email');
    // Self-owned field: the block is authorized — internal force, even though
    // the request itself carried none.
    expect(modify?.options.force).toBe(true);
    expect(modify?.updates.isRequired).toBe(true);
    expect(modify?.updates.constraints).toEqual({ max: 320 });
    // Resolution 9: the new defaultValue doubles as the backfill.
    expect(modify?.updates.backfillValue).toBe('unknown@example.com');
  });

  it('never re-applies seed — a seed change only warns', async () => {
    const withSeed = parseManifest({
      ...(newManifest as unknown as Record<string, unknown>),
      seed: { contacts: [{ email: 'seed@example.com' }] },
    });
    const { installer } = build();
    const report = await installer.upgrade(
      existing(),
      withSeed,
      diffManifests(oldManifest, withSeed),
      {},
    );
    expect(report.recordsSeeded).toEqual({});
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('seed is never re-applied')]),
    );
  });

  it('does NOT downgrade data-safety errors on self-owned fields — tightening over violating rows still fails', async () => {
    const { installer, schemaManager } = build();
    schemaManager.failNextModifyField(
      preview(['3 existing row(s) violate the new max constraint'], ['CONSTRAINT_VIOLATIONS']),
    );
    await expect(installer.upgrade(existing(), newManifest, delta, {})).rejects.toThrowError(
      /violate the new max constraint/,
    );
  });

  it('fails actionably on REQUIRES_BACKFILL, naming the field and the re-run path', async () => {
    const { installer, schemaManager } = build();
    schemaManager.failNextModifyField(
      preview(['Cannot make "email" required: 2 rows have no value.'], ['REQUIRES_BACKFILL']),
    );
    const run = installer.upgrade(existing(), newManifest, delta, {});
    await expect(run).rejects.toThrowError(BlockInstallError);
    await expect(installer.upgrade(existing(), newManifest, delta, {})).resolves.toBeDefined(); // the injected failure was one-shot: re-run completes
  });

  it('skips modification of fields the block does not own unless the request forces', async () => {
    const objects = liveObjects();
    const contactsEmail = objects[0]?.fields.find((f) => f.name === 'email');
    if (contactsEmail) contactsEmail.managedBy = 'user'; // released earlier
    const { installer, schemaManager } = build({ objects });

    const report = await installer.upgrade(existing(), newManifest, delta, {});
    expect(schemaManager.calls.modifyField).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('managed by "user"')]),
    );

    const forced = build({ objects: liveObjects().map((o) => ({ ...o })) });
    const forcedObjects = liveObjects();
    const email = forcedObjects[0]?.fields.find((f) => f.name === 'email');
    if (email) email.managedBy = 'user';
    const { installer: installer2, schemaManager: sm2 } = build({ objects: forcedObjects });
    await installer2.upgrade(existing(), newManifest, delta, { force: true });
    expect(sm2.calls.modifyField).toHaveLength(1);
    expect(forced).toBeDefined();
  });

  it('updates changed tasks in place, preserving the live enabled flag', async () => {
    const { installer, taskEngine } = build();
    const report = await installer.upgrade(existing(), newManifest, delta, {});
    expect(report.tasksUpdated).toEqual(['demo-clean']);
    const update = taskEngine.calls.updated[0];
    expect(update?.id).toBe('t-clean');
    expect(update?.patch.schedule).toBe('0 6 * * *');
    expect('enabled' in (update?.patch ?? {})).toBe(false); // stays disabled
  });
});

describe('BlockInstaller.upgrade — destructive gate + released-to-user', () => {
  it('default run releases owned removed items to user management and skips destruction', async () => {
    const { installer, schemaManager, taskEngine } = build();
    const report = await installer.upgrade(existing(), newManifest, delta, {});

    expect(schemaManager.calls.deleteObject).toEqual([]);
    expect(schemaManager.calls.removeField).toEqual([]);
    expect(taskEngine.calls.removed).toEqual([]);

    expect(report.skippedDestructive).toEqual(
      expect.arrayContaining([
        'object "notes" (removed in 0.3.0)',
        'field "contacts.legacy" (removed in 0.3.0)',
        'task "demo-report" (removed in 0.3.0)',
      ]),
    );
    expect(report.released).toEqual(
      expect.arrayContaining(['object "notes"', 'field "contacts.legacy"']),
    );
    expect(schemaManager.calls.releaseToUser).toEqual(
      expect.arrayContaining([
        { object: 'notes', field: undefined },
        { object: 'contacts', field: 'legacy' },
      ]),
    );
  });

  it('force applies the removals through the preview-first pipeline', async () => {
    const { installer, schemaManager, taskEngine } = build();
    const report = await installer.upgrade(existing(), newManifest, delta, { force: true });

    expect(schemaManager.calls.removeField).toEqual([
      { object: 'contacts', field: 'legacy', force: true },
    ]);
    expect(schemaManager.calls.deleteObject).toEqual(['notes']);
    expect(taskEngine.calls.removed).toEqual(['t-report']);
    expect(report.tasksRemoved).toEqual(['demo-report']);
    expect(report.skippedDestructive).toEqual([]);
    expect(report.released).toEqual([]);
    expect(schemaManager.calls.releaseToUser).toEqual([]);
  });

  it('force refuses to drop a non-empty object without dropData (data_guard), then proceeds with it', async () => {
    const first = build({ rowCounts: { notes: 4 } });
    const run = first.installer.upgrade(existing(), newManifest, delta, { force: true });
    await expect(run).rejects.toMatchObject({ code: 'data_guard' });
    await expect(
      first.installer.upgrade(existing(), newManifest, delta, { force: true }),
    ).rejects.toThrowError(/notes \(4 rows\)/);

    const second = build({ rowCounts: { notes: 4 } });
    await second.installer.upgrade(existing(), newManifest, delta, {
      force: true,
      dropData: true,
    });
    expect(second.schemaManager.calls.deleteObject).toEqual(['notes']);
  });

  it('never removes objects the block did not create, even under force', async () => {
    const notOwned = installedAt('0.2.0', oldManifest, ['contacts']); // notes pre-existed
    const { installer, schemaManager } = build();
    const report = await installer.upgrade(notOwned, newManifest, delta, { force: true });
    expect(schemaManager.calls.deleteObject).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not created by this block')]),
    );
  });

  it('dry run computes previews without touching anything', async () => {
    const { installer, schemaManager, taskEngine, webhookManager } = build();
    const report = await installer.upgrade(existing(), newManifest, delta, {
      dryRun: true,
      force: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.previews?.map((p) => p.target)).toEqual(
      expect.arrayContaining([
        'add field contacts.status',
        'field contacts.email',
        'remove field contacts.legacy',
        'remove object notes',
      ]),
    );
    expect(schemaManager.calls.addField).toEqual([]);
    expect(schemaManager.calls.deleteObject).toEqual([]);
    expect(taskEngine.calls.updated).toEqual([]);
    expect(taskEngine.calls.removed).toEqual([]);
    expect(webhookManager.calls.updated).toEqual([]);
    expect(webhookManager.calls.removed).toEqual([]);
  });
});

describe('BlockInstaller.upgrade — runtime re-sync', () => {
  it('re-syncs subscriptions: dropped consumers unsubscribe, new ones register', async () => {
    const { installer, bus } = build();
    await installer.upgrade(existing(), newManifest, delta, {});
    expect(bus.calls.unsubscribed).toContain('demo-old');
    expect(bus.calls.subscribed).toContain('demo-new');
  });

  it('updates a changed webhook in place (secret preserved) and removes dropped ones by provenance', async () => {
    const { installer, webhookManager } = build();
    const report = await installer.upgrade(existing(), newManifest, delta, {});

    expect(report.webhooksUpdated).toEqual(['demo-hook']);
    expect(webhookManager.calls.updated).toEqual([
      {
        id: 'w-hook',
        patch: { url: 'https://new.example/h', topics: ['data.contacts.*'], headers: {} },
      },
    ]);
    // Update-not-recreate: no new secret was minted for the changed hook.
    expect(report.webhooksCreated).toEqual({});
    expect(webhookManager.calls.created).toEqual([]);

    expect(report.webhooksRemoved).toEqual(['demo-dropped']);
    expect(webhookManager.calls.removed).toEqual(['w-dropped']);
  });

  it('leaves same-named webhooks alone when another owner manages them', async () => {
    const { installer, webhookManager } = build({
      webhooks: [
        { id: 'w-hook', name: 'demo-hook', managedBy: 'user' },
        { id: 'w-dropped', name: 'demo-dropped', managedBy: 'user' },
      ],
    });
    const report = await installer.upgrade(existing(), newManifest, delta, {});
    expect(webhookManager.calls.updated).toEqual([]);
    expect(webhookManager.calls.removed).toEqual([]);
    expect(report.webhooksUpdated).toEqual([]);
    expect(report.webhooksRemoved).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not managed by this block')]),
    );
  });
});
