/**
 * Relation keys — the single source of truth for how an object's relationships
 * are addressed on the data surfaces (Phase 13).
 *
 * A **relation key** is the name under which related records attach to a row:
 * the `expand=` value on REST/MCP, the nested field name on GraphQL, and the
 * key `DataService.hydrateRelation` writes onto the row. Three shapes exist:
 *
 *  - `via: 'fk'` — the FK column lives on *this* object (`many_to_one` /
 *    `one_to_one` source, or the "many" side of a `one_to_many`). Key is the
 *    relationship name; attaches a single record (or null).
 *  - `via: 'reverse'` — the FK lives on the *other* object and this is the
 *    "one" side. The stored relationship name reads as the belongs-to
 *    direction (contacts' `company`), so the reverse key is
 *    **`<fkObject>_by_<relName>`** (companies' `contacts_by_company`) —
 *    unambiguous because relationship names are scoped per source object.
 *    Attaches a list (or a single record for `one_to_one`).
 *  - `via: 'junction'` — `many_to_many`; the relationship name works from
 *    either side and attaches a list.
 *
 * Column fields own their names: a relation key that collides with a field
 * name is dropped (defensive — FK columns are `<rel>_id`, so in practice this
 * only triggers on adversarial naming).
 */

import type { DataObjectDefinition, RelationshipDefinition } from '../schema/types.js';

export interface RelationKey {
  /** The expand key / GraphQL field name the related records attach under. */
  key: string;
  rel: RelationshipDefinition;
  /** 'single' attaches `Record | null`; 'list' attaches `Record[]`. */
  kind: 'single' | 'list';
  /** The object whose records are attached under the key. */
  otherObject: string;
  /** How related rows are fetched (see module doc). */
  via: 'fk' | 'reverse' | 'junction';
}

/**
 * Lists every relation key addressable on an object. Self-referential
 * FK relationships yield both sides (e.g. `manager` and
 * `contacts_by_manager` on the same object).
 */
export function listRelationKeys(obj: DataObjectDefinition): RelationKey[] {
  const keys = (obj.relationships ?? []).flatMap((rel) => keysForRelationship(obj.name, rel));
  const fieldNames = new Set(obj.fields.map((f) => f.name));
  return keys.filter((k) => !fieldNames.has(k.key));
}

/** The relation keys one relationship contributes to `objectName`'s surface. */
function keysForRelationship(objectName: string, rel: RelationshipDefinition): RelationKey[] {
  if (rel.type === 'many_to_many') {
    const isSource = rel.sourceObjectName === objectName;
    const otherObject = isSource ? rel.targetObjectName : rel.sourceObjectName;
    return [{ key: rel.name, rel, kind: 'list', otherObject, via: 'junction' }];
  }

  // The FK column lives on the "many" side (the target for one_to_many,
  // the source otherwise) — mirrors SchemaManager.createRelationshipFkColumn.
  const fkObject = rel.type === 'one_to_many' ? rel.targetObjectName : rel.sourceObjectName;
  const oneObject = rel.type === 'one_to_many' ? rel.sourceObjectName : rel.targetObjectName;

  const keys: RelationKey[] = [];
  if (fkObject === objectName) {
    keys.push({ key: rel.name, rel, kind: 'single', otherObject: oneObject, via: 'fk' });
  }
  if (oneObject === objectName) {
    keys.push({
      key: `${fkObject}_by_${rel.name}`,
      rel,
      kind: rel.type === 'one_to_one' ? 'single' : 'list',
      otherObject: fkObject,
      via: 'reverse',
    });
  }
  return keys;
}

/** Finds one relation key by its public name, or undefined. */
export function findRelationKey(obj: DataObjectDefinition, key: string): RelationKey | undefined {
  return listRelationKeys(obj).find((k) => k.key === key);
}
