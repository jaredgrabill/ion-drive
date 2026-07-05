/**
 * Schema Registry — In-memory cache of the current schema state.
 *
 * The Schema Registry maintains a synchronized, fast-access representation
 * of all data objects, their fields, and relationships. It's populated
 * on startup from the Metadata Store and kept in sync as schema changes
 * are applied.
 *
 * Other parts of the system (API generators, MCP server, admin console)
 * read from the Schema Registry instead of querying the database for
 * every request.
 */

import type { MetadataStore } from './metadata-store.js';
import type {
  DataObjectDefinition,
  FieldDefinition,
  RelationshipDefinition,
  SchemaState,
} from './types.js';

export class SchemaRegistry {
  private state: SchemaState;
  private listeners: Set<(state: SchemaState) => void> = new Set();

  constructor() {
    this.state = {
      objects: new Map(),
      relationships: [],
      version: 0,
      lastUpdated: new Date(),
    };
  }

  /**
   * Loads the full schema state from the Metadata Store.
   * Called during startup and on-demand for full refresh.
   */
  async loadFromStore(store: MetadataStore): Promise<void> {
    const definitions = await store.getAllObjectDefinitions();

    const objects = new Map<string, DataObjectDefinition>();
    const relationships: RelationshipDefinition[] = [];

    for (const def of definitions) {
      objects.set(def.name, def);
      if (def.relationships) {
        relationships.push(...def.relationships);
      }
    }

    this.state = {
      objects,
      relationships,
      version: this.state.version + 1,
      lastUpdated: new Date(),
    };

    this.notifyListeners();
  }

  // -------------------------------------------------------------------------
  // Read operations (fast, in-memory)
  // -------------------------------------------------------------------------

  getState(): Readonly<SchemaState> {
    return this.state;
  }

  getVersion(): number {
    return this.state.version;
  }

  listObjects(): DataObjectDefinition[] {
    return Array.from(this.state.objects.values());
  }

  getObject(name: string): DataObjectDefinition | undefined {
    return this.state.objects.get(name);
  }

  objectExists(name: string): boolean {
    return this.state.objects.has(name);
  }

  getFields(objectName: string): FieldDefinition[] {
    return this.state.objects.get(objectName)?.fields ?? [];
  }

  getField(objectName: string, fieldName: string): FieldDefinition | undefined {
    return this.state.objects.get(objectName)?.fields.find((f) => f.name === fieldName);
  }

  getRelationships(objectName: string): RelationshipDefinition[] {
    return this.state.relationships.filter(
      (r) => r.sourceObjectName === objectName || r.targetObjectName === objectName,
    );
  }

  getAllRelationships(): RelationshipDefinition[] {
    return [...this.state.relationships];
  }

  /**
   * Returns the table name for a data object.
   * This is used by the data access layer to query tenant tables.
   */
  getTableName(objectName: string): string | undefined {
    return this.state.objects.get(objectName)?.tableName;
  }

  // -------------------------------------------------------------------------
  // Write operations (update cache after schema changes)
  // -------------------------------------------------------------------------

  registerObject(definition: DataObjectDefinition): void {
    this.state.objects.set(definition.name, definition);
    if (definition.relationships) {
      for (const rel of definition.relationships) {
        if (!this.state.relationships.some((r) => r.name === rel.name)) {
          this.state.relationships.push(rel);
        }
      }
    }
    this.bumpVersion();
  }

  unregisterObject(name: string): void {
    this.state.objects.delete(name);
    this.state.relationships = this.state.relationships.filter(
      (r) => r.sourceObjectName !== name && r.targetObjectName !== name,
    );
    this.bumpVersion();
  }

  updateObjectFields(objectName: string, fields: FieldDefinition[]): void {
    const obj = this.state.objects.get(objectName);
    if (obj) {
      obj.fields = fields;
      this.bumpVersion();
    }
  }

  addField(objectName: string, field: FieldDefinition): void {
    const obj = this.state.objects.get(objectName);
    if (obj) {
      obj.fields.push(field);
      this.bumpVersion();
    }
  }

  removeField(objectName: string, fieldName: string): void {
    const obj = this.state.objects.get(objectName);
    if (obj) {
      obj.fields = obj.fields.filter((f) => f.name !== fieldName);
      this.bumpVersion();
    }
  }

  addRelationship(relationship: RelationshipDefinition): void {
    this.state.relationships.push(relationship);
    this.bumpVersion();
  }

  removeRelationship(name: string): void {
    this.state.relationships = this.state.relationships.filter((r) => r.name !== name);
    this.bumpVersion();
  }

  // -------------------------------------------------------------------------
  // Change notification
  // -------------------------------------------------------------------------

  /**
   * Subscribe to schema state changes. Returns an unsubscribe function.
   * Used by API generators to rebuild routes when the schema changes.
   */
  onChange(listener: (state: SchemaState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bumpVersion(): void {
    this.state.version++;
    this.state.lastUpdated = new Date();
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // Don't let a failing listener break other listeners
      }
    }
  }
}
