/**
 * Manifest differ (spec-07) — structural old→new comparison of two block
 * manifests, powering the installer's upgrade mode and (via the dry-run
 * upgrade report's `delta`) the CLI's `ion-drive diff`/`update` rendering.
 *
 * The diff is **structural, not textual**: each manifest section is compared
 * by its natural key and every difference is classified with the schema
 * engine's vocabulary so it reads like a designer ChangePreview:
 *
 * | Section        | Key            | added      | removed       | changed |
 * |----------------|----------------|------------|---------------|---------|
 * | objects        | name           | additive   | destructive   | —  (via fields) |
 * | fields         | object + name  | additive   | destructive   | modifying |
 * | relationships  | source + name  | additive   | destructive   | — (remove+add) |
 * | tasks          | name           | additive   | **destructive** (gated) | modifying (update in place, `enabled` preserved) |
 * | roles          | name           | report-only (installer seeds added roles idempotently; removals/changes never touch live roles) |
 * | subscriptions  | consumer       | re-synced (runtime wiring — applied ungated) |
 * | webhooks       | name           | re-synced (runtime wiring — applied ungated, secret preserved on update) |
 * | actions/hooks  | name           | additive   | additive (declaration-only surface) | — |
 * | seed           | —              | report-only (`seedChanged`) — seed is **never re-applied** on upgrade |
 * | code           | path           | reported for the CLI (byte-equal comparison; the server never writes code) |
 *
 * Field comparison distinguishes **structural** keys (columnType, isRequired,
 * isUnique, defaultValue, constraints — these route through the validated
 * `modifyField` pipeline) from **presentation-only** keys (the ADR-017
 * {@link PRESENTATION_ONLY_KEYS} set) which always apply. Renames are NOT
 * inferred — a renamed field/object diffs as remove + add, deliberately: the
 * manifest carries no rename intent and guessing would risk data loss.
 */

import { PRESENTATION_ONLY_KEYS } from '../schema/types.js';
import type { BlockManifest, BlockObject } from './block-types.js';

/** How a delta entry is classified (the schema-engine vocabulary). */
export type DeltaKind = 'additive' | 'modifying' | 'destructive';

/** One field-level difference on an object present in both versions. */
export interface FieldDelta {
  objectName: string;
  fieldName: string;
  kind: DeltaKind;
  /** For `modifying`: which manifest keys differ. */
  changedKeys?: string[];
  /** True when every changed key is presentation-only (always applies). */
  presentationOnly?: boolean;
  /** The old/new manifest field shapes (for `modifying`/`destructive`). */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** A named add/remove/change on a keyed manifest section. */
export interface NamedDelta<T = Record<string, unknown>> {
  name: string;
  kind: DeltaKind;
  before?: T;
  after?: T;
}

/** The full structural old→new manifest delta. */
export interface ManifestDelta {
  /** Versions being compared. */
  from: string;
  to: string;
  objects: { added: string[]; removed: string[] };
  /** Field-level deltas for objects present in both versions. */
  fields: FieldDelta[];
  /** Keyed `<sourceObject>.<name>`. */
  relationships: { added: string[]; removed: string[] };
  /** added=additive, removed=destructive (gated), changed=modifying. */
  tasks: NamedDelta[];
  /** Report-only: the installer never mutates or removes live roles. */
  roles: NamedDelta[];
  /** Keyed by consumer group — runtime wiring, re-synced ungated. */
  subscriptions: { added: string[]; removed: string[]; changed: string[] };
  /** Keyed by name — runtime wiring, re-synced ungated (secret preserved). */
  webhooks: { added: string[]; removed: string[]; changed: string[] };
  actions: { added: string[]; removed: string[] };
  hooks: { added: string[]; removed: string[] };
  /** Report-only: seed data is never re-applied on upgrade. */
  seedChanged: boolean;
  /** Vendored code, byte-compared — consumed by the CLI, never the server. */
  code: { added: string[]; removed: string[]; changed: string[] };
  /** True when any section differs. */
  hasChanges: boolean;
}

/** Field keys compared structurally (route through `modifyField`). */
export const STRUCTURAL_FIELD_KEYS = [
  'columnType',
  'isRequired',
  'isUnique',
  'defaultValue',
  'constraints',
] as const;

/**
 * Field keys compared as presentation-only — ADR-017's canonical set
 * (displayName/description/uiOptions/isIndexed/sortOrder), reused verbatim.
 */
export const PRESENTATION_FIELD_KEYS: readonly string[] = [...PRESENTATION_ONLY_KEYS];

/** Computes the structural delta between two parsed manifests. */
export function diffManifests(
  oldManifest: BlockManifest,
  newManifest: BlockManifest,
): ManifestDelta {
  const objects = diffNames(
    oldManifest.objects.map((o) => o.name),
    newManifest.objects.map((o) => o.name),
  );
  const delta: ManifestDelta = {
    from: oldManifest.version,
    to: newManifest.version,
    objects: { added: objects.added, removed: objects.removed },
    fields: diffFields(oldManifest.objects, newManifest.objects),
    relationships: diffNames(
      oldManifest.relationships.map((r) => `${r.sourceObjectName}.${r.name}`),
      newManifest.relationships.map((r) => `${r.sourceObjectName}.${r.name}`),
    ),
    tasks: diffKeyed(oldManifest.tasks, newManifest.tasks, (t) => t.name, {
      removedKind: 'destructive',
    }),
    roles: diffKeyed(oldManifest.roles, newManifest.roles, (r) => r.name, {
      removedKind: 'destructive',
    }),
    subscriptions: diffTriple(
      oldManifest.subscriptions,
      newManifest.subscriptions,
      (s) => s.consumer,
    ),
    webhooks: diffTriple(oldManifest.webhooks, newManifest.webhooks, (w) => w.name),
    actions: diffNames(
      oldManifest.actions.map((a) => a.name),
      newManifest.actions.map((a) => a.name),
    ),
    hooks: diffNames(
      oldManifest.hooks.map((h) => h.name),
      newManifest.hooks.map((h) => h.name),
    ),
    seedChanged: !deepEqual(oldManifest.seed, newManifest.seed),
    code: diffTriple(
      oldManifest.code,
      newManifest.code,
      (f) => f.path,
      (f) => f.contents,
    ),
    hasChanges: false,
  };
  delta.hasChanges = computeHasChanges(delta);
  return delta;
}

/** Whether any section of the delta carries a difference. */
function computeHasChanges(delta: ManifestDelta): boolean {
  const triples = [delta.subscriptions, delta.webhooks, delta.code];
  return (
    delta.objects.added.length > 0 ||
    delta.objects.removed.length > 0 ||
    delta.fields.length > 0 ||
    delta.relationships.added.length > 0 ||
    delta.relationships.removed.length > 0 ||
    delta.tasks.length > 0 ||
    delta.roles.length > 0 ||
    delta.actions.added.length > 0 ||
    delta.actions.removed.length > 0 ||
    delta.hooks.added.length > 0 ||
    delta.hooks.removed.length > 0 ||
    delta.seedChanged ||
    triples.some((t) => t.added.length > 0 || t.removed.length > 0 || t.changed.length > 0)
  );
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

/** added/removed over two name lists. */
function diffNames(oldNames: string[], newNames: string[]): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldNames);
  const newSet = new Set(newNames);
  return {
    added: newNames.filter((n) => !oldSet.has(n)),
    removed: oldNames.filter((n) => !newSet.has(n)),
  };
}

/** added/removed/changed over two keyed lists (deep-equal per entry). */
function diffTriple<T>(
  oldItems: T[],
  newItems: T[],
  keyOf: (item: T) => string,
  projection: (item: T) => unknown = (item) => item,
): { added: string[]; removed: string[]; changed: string[] } {
  const oldMap = new Map(oldItems.map((i) => [keyOf(i), i]));
  const newMap = new Map(newItems.map((i) => [keyOf(i), i]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, item] of newMap) {
    const before = oldMap.get(key);
    if (before === undefined) added.push(key);
    else if (!deepEqual(projection(before), projection(item))) changed.push(key);
  }
  for (const key of oldMap.keys()) {
    if (!newMap.has(key)) removed.push(key);
  }
  return { added, removed, changed };
}

/** NamedDelta list (added/removed/changed) over two keyed lists. */
function diffKeyed<T extends Record<string, unknown>>(
  oldItems: T[],
  newItems: T[],
  keyOf: (item: T) => string,
  opts: { removedKind: DeltaKind },
): NamedDelta[] {
  const oldMap = new Map(oldItems.map((i) => [keyOf(i), i]));
  const newMap = new Map(newItems.map((i) => [keyOf(i), i]));
  const deltas: NamedDelta[] = [];
  for (const [name, after] of newMap) {
    const before = oldMap.get(name);
    if (before === undefined) deltas.push({ name, kind: 'additive', after });
    else if (!deepEqual(before, after)) deltas.push({ name, kind: 'modifying', before, after });
  }
  for (const [name, before] of oldMap) {
    if (!newMap.has(name)) deltas.push({ name, kind: opts.removedKind, before });
  }
  return deltas;
}

/** Field deltas for objects present in both versions. */
function diffFields(oldObjects: BlockObject[], newObjects: BlockObject[]): FieldDelta[] {
  const newByName = new Map(newObjects.map((o) => [o.name, o]));
  const deltas: FieldDelta[] = [];
  for (const oldObj of oldObjects) {
    const newObj = newByName.get(oldObj.name);
    if (!newObj) continue; // whole-object removal is covered by objects.removed
    deltas.push(...diffObjectFields(oldObj, newObj));
  }
  return deltas;
}

/** One object's field-level add/remove/change deltas. */
function diffObjectFields(oldObj: BlockObject, newObj: BlockObject): FieldDelta[] {
  const oldFields = new Map(oldObj.fields.map((f) => [f.name, f]));
  const newFields = new Map(newObj.fields.map((f) => [f.name, f]));
  const deltas: FieldDelta[] = [];

  for (const [name, after] of newFields) {
    const before = oldFields.get(name);
    if (before === undefined) {
      deltas.push({ objectName: oldObj.name, fieldName: name, kind: 'additive', after });
      continue;
    }
    const changedKeys = changedFieldKeys(before, after);
    if (changedKeys.length === 0) continue;
    deltas.push({
      objectName: oldObj.name,
      fieldName: name,
      kind: 'modifying',
      changedKeys,
      presentationOnly: changedKeys.every((k) => PRESENTATION_FIELD_KEYS.includes(k)),
      before,
      after,
    });
  }
  for (const [name, before] of oldFields) {
    if (!newFields.has(name)) {
      deltas.push({ objectName: oldObj.name, fieldName: name, kind: 'destructive', before });
    }
  }
  return deltas;
}

/** The manifest keys whose (normalized) values differ between two fields. */
function changedFieldKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = [...STRUCTURAL_FIELD_KEYS, ...PRESENTATION_FIELD_KEYS];
  return keys.filter(
    (key) =>
      !deepEqual(normalizeFieldValue(key, before[key]), normalizeFieldValue(key, after[key])),
  );
}

/**
 * Normalizes optional manifest field values so "omitted" and "explicit
 * default" compare equal (`isRequired: false` vs absent, `defaultValue: null`
 * vs absent, …) — otherwise every manifest that tidied its syntax would diff.
 */
function normalizeFieldValue(key: string, value: unknown): unknown {
  if (key === 'isRequired' || key === 'isUnique' || key === 'isIndexed') return value ?? false;
  return value ?? null;
}

/** Structural deep equality over JSON-shaped values (order-insensitive keys). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).filter((k) => aObj[k] !== undefined);
  const bKeys = Object.keys(bObj).filter((k) => bObj[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}
