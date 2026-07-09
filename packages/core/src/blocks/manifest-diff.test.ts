/**
 * Unit tests for the manifest differ (spec-07): the add/remove/modify matrix
 * across every manifest section, the structural-vs-presentation field key
 * split, normalization of omitted optionals, and the no-rename rule.
 */

import { describe, expect, it } from 'vitest';
import { parseManifest } from './block-manifest.js';
import type { BlockManifestInput } from './block-types.js';
import { deepEqual, diffManifests } from './manifest-diff.js';

/** A parsed manifest from a partial input (name/title defaulted). */
function m(input: Partial<BlockManifestInput> & { version: string }) {
  return parseManifest({ name: 'demo', title: 'Demo', ...input });
}

const field = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  displayName: name,
  columnType: 'text' as const,
  ...extra,
});

const object = (name: string, fields: ReturnType<typeof field>[]) => ({
  name,
  displayName: name,
  fields,
});

describe('diffManifests — objects and fields', () => {
  it('reports identical manifests as no change', () => {
    const a = m({ version: '0.2.0', objects: [object('contacts', [field('email')])] });
    const b = m({ version: '0.2.0', objects: [object('contacts', [field('email')])] });
    const delta = diffManifests(a, b);
    expect(delta.hasChanges).toBe(false);
    expect(delta.fields).toEqual([]);
  });

  it('classifies added objects additive and removed objects destructive', () => {
    const a = m({ version: '0.2.0', objects: [object('contacts', [field('email')])] });
    const b = m({ version: '0.3.0', objects: [object('companies', [field('name')])] });
    const delta = diffManifests(a, b);
    expect(delta.objects).toEqual({ added: ['companies'], removed: ['contacts'] });
    // Fields of removed/added objects are NOT enumerated — the object entry covers them.
    expect(delta.fields).toEqual([]);
    expect(delta.from).toBe('0.2.0');
    expect(delta.to).toBe('0.3.0');
  });

  it('classifies field add/remove/change on a shared object', () => {
    const a = m({
      version: '0.2.0',
      objects: [object('contacts', [field('email'), field('legacy')])],
    });
    const b = m({
      version: '0.3.0',
      objects: [object('contacts', [field('email', { isRequired: true }), field('status')])],
    });
    const delta = diffManifests(a, b);
    expect(delta.fields).toHaveLength(3);
    const byName = new Map(delta.fields.map((f) => [f.fieldName, f]));
    expect(byName.get('status')?.kind).toBe('additive');
    expect(byName.get('legacy')?.kind).toBe('destructive');
    expect(byName.get('email')?.kind).toBe('modifying');
    expect(byName.get('email')?.changedKeys).toEqual(['isRequired']);
    expect(byName.get('email')?.presentationOnly).toBe(false);
  });

  it('marks presentation-only changes and keeps structural ones separate', () => {
    const a = m({ version: '0.2.0', objects: [object('contacts', [field('email')])] });
    const b = m({
      version: '0.3.0',
      objects: [
        object('contacts', [
          field('email', { displayName: 'E-mail', description: 'primary address', sortOrder: 5 }),
        ]),
      ],
    });
    const [delta] = diffManifests(a, b).fields;
    expect(delta?.kind).toBe('modifying');
    expect(delta?.presentationOnly).toBe(true);
    expect(delta?.changedKeys).toEqual(
      expect.arrayContaining(['displayName', 'description', 'sortOrder']),
    );
  });

  it('compares constraints deep-structurally', () => {
    const a = m({
      version: '0.2.0',
      objects: [object('contacts', [field('age', { constraints: { min: 0, max: 200 } })])],
    });
    const same = m({
      version: '0.2.1',
      objects: [object('contacts', [field('age', { constraints: { max: 200, min: 0 } })])],
    });
    const tightened = m({
      version: '0.3.0',
      objects: [object('contacts', [field('age', { constraints: { min: 0, max: 120 } })])],
    });
    expect(diffManifests(a, same).fields).toEqual([]);
    const [delta] = diffManifests(a, tightened).fields;
    expect(delta?.changedKeys).toEqual(['constraints']);
  });

  it('treats omitted optionals as their defaults (no noise diffs)', () => {
    const a = m({
      version: '0.2.0',
      objects: [object('contacts', [field('email', { isRequired: false, defaultValue: null })])],
    });
    const b = m({ version: '0.2.1', objects: [object('contacts', [field('email')])] });
    expect(diffManifests(a, b).fields).toEqual([]);
  });

  it('does not infer renames — a renamed field is remove + add', () => {
    const a = m({ version: '0.2.0', objects: [object('contacts', [field('mail')])] });
    const b = m({ version: '0.3.0', objects: [object('contacts', [field('email')])] });
    const kinds = diffManifests(a, b).fields.map((f) => `${f.fieldName}:${f.kind}`);
    expect(kinds.sort()).toEqual(['email:additive', 'mail:destructive']);
  });
});

describe('diffManifests — the remaining sections', () => {
  const rel = (name: string, source: string, target: string) => ({
    name,
    displayName: name,
    type: 'many_to_one' as const,
    sourceObjectName: source,
    targetObjectName: target,
  });

  it('keys relationships by source object + name', () => {
    const a = m({ version: '0.2.0', relationships: [rel('company', 'contacts', 'companies')] });
    const b = m({ version: '0.3.0', relationships: [rel('company', 'deals', 'companies')] });
    const delta = diffManifests(a, b);
    expect(delta.relationships.removed).toEqual(['contacts.company']);
    expect(delta.relationships.added).toEqual(['deals.company']);
  });

  it('classifies tasks: added additive, removed destructive, changed modifying', () => {
    const a = m({
      version: '0.2.0',
      tasks: [
        { name: 'old', type: 'noop' },
        { name: 'kept', type: 'noop', schedule: '0 0 * * *' },
      ],
    });
    const b = m({
      version: '0.3.0',
      tasks: [
        { name: 'kept', type: 'noop', schedule: '0 6 * * *' },
        { name: 'fresh', type: 'log' },
      ],
    });
    const tasks = new Map(diffManifests(a, b).tasks.map((t) => [t.name, t.kind]));
    expect(tasks.get('old')).toBe('destructive');
    expect(tasks.get('kept')).toBe('modifying');
    expect(tasks.get('fresh')).toBe('additive');
  });

  it('keys subscriptions by consumer and webhooks by name', () => {
    const a = m({
      version: '0.2.0',
      subscriptions: [{ event: 'data.#', consumer: 'audit', handler: 'persist_event' }],
      webhooks: [{ name: 'notify', url: 'https://a.example/h', topics: ['data.#'] }],
    });
    const b = m({
      version: '0.3.0',
      subscriptions: [
        { event: 'data.contacts.*', consumer: 'audit', handler: 'persist_event' },
        { event: 'data.#', consumer: 'mirror', handler: 'log_event' },
      ],
      webhooks: [{ name: 'notify', url: 'https://b.example/h', topics: ['data.#'] }],
    });
    const delta = diffManifests(a, b);
    expect(delta.subscriptions).toEqual({ added: ['mirror'], removed: [], changed: ['audit'] });
    expect(delta.webhooks).toEqual({ added: [], removed: [], changed: ['notify'] });
  });

  it('diffs actions/hooks by name and seed as a report-only boolean', () => {
    const a = m({
      version: '0.2.0',
      seed: { contacts: [{ email: 'a@b.c' }] },
      actions: [{ name: 'ping' }],
      hooks: [{ name: 'stripe' }],
      objects: [object('contacts', [field('email')])],
    });
    const b = m({
      version: '0.3.0',
      seed: { contacts: [{ email: 'a@b.c' }, { email: 'd@e.f' }] },
      actions: [{ name: 'pong' }],
      hooks: [],
      objects: [object('contacts', [field('email')])],
    });
    const delta = diffManifests(a, b);
    expect(delta.actions).toEqual({ added: ['pong'], removed: ['ping'] });
    expect(delta.hooks).toEqual({ added: [], removed: ['stripe'] });
    expect(delta.seedChanged).toBe(true);
    expect(delta.hasChanges).toBe(true);
  });

  it('byte-compares code files', () => {
    const a = m({
      version: '0.2.0',
      code: [
        { path: 'index.ts', contents: 'export {};\n' },
        { path: 'gone.ts', contents: '// bye\n' },
      ],
    });
    const b = m({
      version: '0.3.0',
      code: [
        { path: 'index.ts', contents: 'export const x = 1;\n' },
        { path: 'new.ts', contents: '// hi\n' },
      ],
    });
    expect(diffManifests(a, b).code).toEqual({
      added: ['new.ts'],
      removed: ['gone.ts'],
      changed: ['index.ts'],
    });
  });
});

describe('deepEqual', () => {
  it('is order-insensitive over keys and strict over arrays', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});
