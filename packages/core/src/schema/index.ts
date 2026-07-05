/**
 * Schema module — public API for Ion Drive's schema engine.
 */

export { SchemaManager } from './schema-manager.js';
export type { SchemaManagerOptions } from './schema-manager.js';
export { MetadataStore } from './metadata-store.js';
export { DdlExecutor } from './ddl-executor.js';
export { SchemaRegistry } from './schema-registry.js';
export { ChangeValidator } from './change-validator.js';
export { bootstrapSystemTables, isBootstrapped } from './system-tables.js';

export type {
  ColumnTypeName,
  ColumnTypeInfo,
  RelationshipType,
  DataObjectDefinition,
  FieldDefinition,
  FieldConstraints,
  RelationshipDefinition,
  SchemaChangeType,
  SchemaChange,
  ChangeSet,
  ChangePreview,
  ChangeWarning,
  ChangeError,
  SchemaState,
} from './types.js';

export { COLUMN_TYPES, SYSTEM_FIELDS } from './types.js';
