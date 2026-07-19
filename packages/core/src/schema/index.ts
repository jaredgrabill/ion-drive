/**
 * Schema module — public API for Ion Drive's schema engine.
 */

export { SchemaManager } from './schema-manager.js';
export type { FieldChangeOptions, SchemaManagerOptions } from './schema-manager.js';
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
  FieldModification,
  ManagedBy,
  ObjectConstraints,
  RelationshipDefinition,
  SchemaChangeType,
  SchemaChange,
  ChangeSet,
  ChangePreview,
  ChangeWarning,
  ChangeError,
  SchemaState,
} from './types.js';

export { COLUMN_TYPES, managedByBlock, PRESENTATION_ONLY_KEYS, SYSTEM_FIELDS } from './types.js';
export { assessTypeChange, textLimit } from './type-compat.js';
export type { TypeChangeAssessment, TypeChangePrecheck } from './type-compat.js';
export { buildCheckConstraints, checkConstraintPrefix } from './check-constraints.js';
export type { CheckConstraintSpec } from './check-constraints.js';
export {
  diffUniqueTogether,
  matchesUniqueTogether,
  resolveUniqueTogether,
} from './unique-together.js';
export type { UniqueTogetherResolution } from './unique-together.js';
export {
  applySnapshot,
  diffSnapshot,
  exportSnapshot,
  SNAPSHOT_FORMAT_VERSION,
} from './snapshot.js';
export type {
  SchemaSnapshot,
  SnapshotApplyResult,
  SnapshotDiffEntry,
  SnapshotField,
  SnapshotObject,
  SnapshotRelationship,
} from './snapshot.js';
export { DOCTOR_IGNORES_KEY, inferColumnType, SchemaDoctor } from './doctor.js';
export type { DoctorFinding, DoctorFindingKind, DoctorReport } from './doctor.js';
