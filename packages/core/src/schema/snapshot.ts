/**
 * Schema snapshot export/import (Phase 10 / ADR-017 rule 3 — "drift is made
 * boring"). A snapshot is a full declarative description of the user-defined
 * schema: objects, fields (constraints + presentation metadata included), and
 * relationships. It is Git-friendly (stable ordering, no volatile ids), so
 * `ion-drive schema pull/diff/push` can version schema alongside code and
 * promote it between environments, PocketBase-style.
 *
 * Importing never bypasses safety: `diffSnapshot` turns snapshot-vs-live into
 * the schema engine's own change primitives (create_object/add_field/
 * modify_field/…), and `applySnapshot` executes them through the normal
 * validated SchemaManager pipeline — every type change, constraint tightening,
 * or required-toggle gets the same pre-checks a manual edit would.
 */

import type { SchemaManager } from './schema-manager.js';
import type {
  ChangePreview,
  DataObjectDefinition,
  FieldDefinition,
  FieldModification,
  RelationshipDefinition,
} from './types.js';

// ---------------------------------------------------------------------------
// Snapshot format
// ---------------------------------------------------------------------------

export const SNAPSHOT_FORMAT_VERSION = 1;

export interface SnapshotField {
  name: string;
  displayName: string;
  columnType: string;
  isRequired?: boolean;
  isUnique?: boolean;
  isIndexed?: boolean;
  defaultValue?: string | null;
  constraints?: FieldDefinition['constraints'];
  sortOrder?: number;
  description?: string | null;
  uiOptions?: Record<string, unknown> | null;
  managedBy?: string;
}

export interface SnapshotObject {
  name: string;
  displayName: string;
  description?: string;
  managedBy?: string;
  fields: SnapshotField[];
}

export interface SnapshotRelationship {
  name: string;
  displayName: string;
  type: string;
  sourceObjectName: string;
  targetObjectName: string;
  cascadeDelete?: boolean;
  managedBy?: string;
}

export interface SchemaSnapshot {
  formatVersion: number;
  exportedAt: string;
  objects: SnapshotObject[];
  relationships: SnapshotRelationship[];
}

/** One entry of a snapshot diff — a change the target instance needs. */
export interface SnapshotDiffEntry {
  kind:
    | 'create_object'
    | 'delete_object'
    | 'add_field'
    | 'modify_field'
    | 'remove_field'
    | 'add_relationship';
  objectName: string;
  fieldName?: string;
  relationshipName?: string;
  summary: string;
  /** For modify_field — the exact updates to apply. */
  updates?: FieldModification;
  /** For create_object / add_field — the definition to create. */
  definition?: Record<string, unknown>;
}

export interface SnapshotApplyResult {
  entry: SnapshotDiffEntry;
  success: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Exports the current schema (non-system objects/fields) as a snapshot. */
export function exportSnapshot(objects: DataObjectDefinition[]): SchemaSnapshot {
  const userObjects = objects
    .filter((o) => !o.isSystem)
    .sort((a, b) => a.name.localeCompare(b.name));

  const seenRels = new Set<string>();
  const relationships: SnapshotRelationship[] = [];
  for (const obj of userObjects) {
    for (const rel of obj.relationships ?? []) {
      if (seenRels.has(rel.name)) continue;
      seenRels.add(rel.name);
      relationships.push({
        name: rel.name,
        displayName: rel.displayName,
        type: rel.type,
        sourceObjectName: rel.sourceObjectName,
        targetObjectName: rel.targetObjectName,
        cascadeDelete: rel.cascadeDelete || undefined,
        managedBy: rel.managedBy,
      });
    }
  }
  relationships.sort((a, b) => a.name.localeCompare(b.name));

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    objects: userObjects.map((obj) => ({
      name: obj.name,
      displayName: obj.displayName,
      description: obj.description || undefined,
      managedBy: obj.managedBy,
      fields: obj.fields
        .filter((f) => !f.isSystem && !isRelationshipFk(obj, f))
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
        .map(toSnapshotField),
    })),
    relationships,
  };
}

/** FK columns created by relationships are re-created by add_relationship. */
function isRelationshipFk(obj: DataObjectDefinition, field: FieldDefinition): boolean {
  return (obj.relationships ?? []).some((rel) => `${rel.name}_id` === field.name);
}

function toSnapshotField(f: FieldDefinition): SnapshotField {
  return {
    name: f.name,
    displayName: f.displayName,
    columnType: f.columnType,
    isRequired: f.isRequired || undefined,
    isUnique: f.isUnique || undefined,
    isIndexed: f.isIndexed || undefined,
    defaultValue: f.defaultValue ?? undefined,
    constraints: f.constraints ?? undefined,
    sortOrder: f.sortOrder,
    description: f.description ?? undefined,
    uiOptions: f.uiOptions ?? undefined,
    managedBy: f.managedBy,
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface DiffOptions {
  /**
   * Also emit remove_field/delete_object for elements present locally but
   * absent from the snapshot. Off by default — pruning is opt-in because it
   * destroys data.
   */
  prune?: boolean;
}

/** Computes the changes needed to bring `current` in line with `snapshot`. */
export function diffSnapshot(
  snapshot: SchemaSnapshot,
  current: DataObjectDefinition[],
  options: DiffOptions = {},
): SnapshotDiffEntry[] {
  const entries: SnapshotDiffEntry[] = [];
  const currentByName = new Map(current.filter((o) => !o.isSystem).map((o) => [o.name, o]));
  const snapshotNames = new Set(snapshot.objects.map((o) => o.name));

  for (const snapObj of snapshot.objects) {
    const existing = currentByName.get(snapObj.name);
    if (!existing) {
      entries.push({
        kind: 'create_object',
        objectName: snapObj.name,
        summary: `Create object "${snapObj.name}" with ${snapObj.fields.length} field(s)`,
        definition: snapObj as unknown as Record<string, unknown>,
      });
      continue;
    }
    entries.push(...diffObjectFields(snapObj, existing, options));
  }

  if (options.prune) {
    for (const [name] of currentByName) {
      if (!snapshotNames.has(name)) {
        entries.push({
          kind: 'delete_object',
          objectName: name,
          summary: `Delete object "${name}" (not in snapshot)`,
        });
      }
    }
  }

  // Relationships: add missing (matched by name). Removal is not supported.
  const currentRelNames = new Set(
    current.flatMap((o) => (o.relationships ?? []).map((r) => r.name)),
  );
  for (const rel of snapshot.relationships) {
    if (!currentRelNames.has(rel.name)) {
      entries.push({
        kind: 'add_relationship',
        objectName: rel.sourceObjectName,
        relationshipName: rel.name,
        summary: `Add ${rel.type} relationship "${rel.name}" (${rel.sourceObjectName} → ${rel.targetObjectName})`,
        definition: rel as unknown as Record<string, unknown>,
      });
    }
  }

  return entries;
}

/** Field-level diff for an object present on both sides. */
function diffObjectFields(
  snapObj: SnapshotObject,
  existing: DataObjectDefinition,
  options: DiffOptions,
): SnapshotDiffEntry[] {
  const entries: SnapshotDiffEntry[] = [];
  const existingFields = new Map(
    existing.fields.filter((f) => !f.isSystem).map((f) => [f.name, f]),
  );
  const snapshotFieldNames = new Set(snapObj.fields.map((f) => f.name));

  for (const snapField of snapObj.fields) {
    const current = existingFields.get(snapField.name);
    if (!current) {
      entries.push({
        kind: 'add_field',
        objectName: snapObj.name,
        fieldName: snapField.name,
        summary: `Add field "${snapField.name}" (${snapField.columnType}) to "${snapObj.name}"`,
        definition: snapField as unknown as Record<string, unknown>,
      });
      continue;
    }
    const updates = fieldUpdates(snapField, current);
    if (Object.keys(updates).length > 0) {
      entries.push({
        kind: 'modify_field',
        objectName: snapObj.name,
        fieldName: snapField.name,
        summary: `Modify field "${snapObj.name}.${snapField.name}" (${Object.keys(updates).join(', ')})`,
        updates,
      });
    }
  }

  if (options.prune) {
    for (const [name, field] of existingFields) {
      if (!snapshotFieldNames.has(name) && !isRelationshipFk(existing, field)) {
        entries.push({
          kind: 'remove_field',
          objectName: snapObj.name,
          fieldName: name,
          summary: `Remove field "${snapObj.name}.${name}" (not in snapshot)`,
        });
      }
    }
  }

  return entries;
}

/** Whether two optional booleans differ (absent means false). */
function flagChanged(snap: boolean | undefined, current: boolean | undefined): boolean {
  return (snap ?? false) !== (current ?? false);
}

/** Computes the FieldModification that turns `current` into `snap`. */
function fieldUpdates(snap: SnapshotField, current: FieldDefinition): FieldModification {
  return {
    ...structuralFieldUpdates(snap, current),
    ...presentationFieldUpdates(snap, current),
  };
}

/** Structural half of {@link fieldUpdates}: type, flags, default, constraints. */
function structuralFieldUpdates(snap: SnapshotField, current: FieldDefinition): FieldModification {
  const updates: FieldModification = {};

  if (snap.columnType !== current.columnType) {
    updates.columnType = snap.columnType as FieldDefinition['columnType'];
  }
  if (flagChanged(snap.isRequired, current.isRequired)) {
    updates.isRequired = snap.isRequired ?? false;
  }
  if (flagChanged(snap.isUnique, current.isUnique)) {
    updates.isUnique = snap.isUnique ?? false;
  }
  if (flagChanged(snap.isIndexed, current.isIndexed)) {
    updates.isIndexed = snap.isIndexed ?? false;
  }
  if ((snap.defaultValue ?? null) !== (current.defaultValue ?? null)) {
    updates.defaultValue = snap.defaultValue ?? null;
  }
  if (normalize(snap.constraints) !== normalize(current.constraints)) {
    updates.constraints = snap.constraints ?? null;
  }

  return updates;
}

/** Presentation half of {@link fieldUpdates}: display name, description, uiOptions, sort. */
function presentationFieldUpdates(
  snap: SnapshotField,
  current: FieldDefinition,
): FieldModification {
  const updates: FieldModification = {};

  if (snap.displayName !== current.displayName) updates.displayName = snap.displayName;
  if ((snap.description ?? null) !== (current.description ?? null)) {
    updates.description = snap.description ?? null;
  }
  if (normalize(snap.uiOptions) !== normalize(current.uiOptions)) {
    updates.uiOptions = snap.uiOptions ?? null;
  }
  if (snap.sortOrder !== undefined && snap.sortOrder !== (current.sortOrder ?? 0)) {
    updates.sortOrder = snap.sortOrder;
  }

  return updates;
}

/** Stable stringification for structural comparison (recursively sorted keys). */
function normalize(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Applies a snapshot diff through the SchemaManager, entry by entry, in a
 * dependency-safe order (creates → field changes → relationships → prunes).
 * Each entry reports its own success/errors; a failed entry does not stop the
 * rest (they are independent validated operations).
 */
export async function applySnapshot(
  schemaManager: SchemaManager,
  entries: SnapshotDiffEntry[],
  options: { force?: boolean } = {},
): Promise<SnapshotApplyResult[]> {
  const order: Record<SnapshotDiffEntry['kind'], number> = {
    create_object: 0,
    add_field: 1,
    modify_field: 2,
    add_relationship: 3,
    remove_field: 4,
    delete_object: 5,
  };
  const sorted = [...entries].sort((a, b) => order[a.kind] - order[b.kind]);

  const results: SnapshotApplyResult[] = [];
  for (const entry of sorted) {
    results.push(await applyEntry(schemaManager, entry, options));
  }
  return results;
}

async function applyEntry(
  schemaManager: SchemaManager,
  entry: SnapshotDiffEntry,
  options: { force?: boolean },
): Promise<SnapshotApplyResult> {
  const finish = (result: { success: boolean; preview: ChangePreview }): SnapshotApplyResult => ({
    entry,
    success: result.success,
    errors: result.preview.errors.map((e) => e.message),
    warnings: result.preview.warnings.map((w) => w.message),
  });

  try {
    switch (entry.kind) {
      case 'create_object': {
        const def = entry.definition as unknown as SnapshotObject;
        return finish(
          await schemaManager.createObject({
            name: def.name,
            displayName: def.displayName,
            description: def.description,
            tableName: def.name,
            managedBy: def.managedBy as DataObjectDefinition['managedBy'],
            fields: def.fields.map((f) => snapshotFieldToDefinition(f)),
          }),
        );
      }
      case 'add_field': {
        const def = entry.definition as unknown as SnapshotField;
        return finish(
          await schemaManager.addField(entry.objectName, snapshotFieldToDefinition(def)),
        );
      }
      case 'modify_field':
        return finish(
          await schemaManager.modifyField(
            entry.objectName,
            entry.fieldName ?? '',
            entry.updates ?? {},
            { force: options.force },
          ),
        );
      case 'add_relationship': {
        const def = entry.definition as unknown as SnapshotRelationship;
        return finish(
          await schemaManager.addRelationship({
            name: def.name,
            displayName: def.displayName,
            type: def.type as RelationshipDefinition['type'],
            sourceObjectName: def.sourceObjectName,
            targetObjectName: def.targetObjectName,
            cascadeDelete: def.cascadeDelete,
            managedBy: def.managedBy as RelationshipDefinition['managedBy'],
          }),
        );
      }
      case 'remove_field':
        return finish(
          await schemaManager.removeField(entry.objectName, entry.fieldName ?? '', {
            force: options.force,
          }),
        );
      case 'delete_object':
        return finish(await schemaManager.deleteObject(entry.objectName));
    }
  } catch (err) {
    return { entry, success: false, errors: [(err as Error).message], warnings: [] };
  }
}

function snapshotFieldToDefinition(f: SnapshotField): FieldDefinition {
  return {
    name: f.name,
    displayName: f.displayName,
    columnName: f.name,
    columnType: f.columnType as FieldDefinition['columnType'],
    isRequired: f.isRequired,
    isUnique: f.isUnique,
    isIndexed: f.isIndexed,
    defaultValue: f.defaultValue ?? undefined,
    constraints: f.constraints,
    sortOrder: f.sortOrder,
    description: f.description ?? undefined,
    uiOptions: f.uiOptions ?? undefined,
    managedBy: f.managedBy as FieldDefinition['managedBy'],
  };
}
