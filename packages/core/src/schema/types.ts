/**
 * Core type definitions for Ion Drive's schema system.
 *
 * These types represent the domain model for data objects, fields,
 * relationships, and schema change operations. They are used by
 * the Schema Manager, Metadata Store, and Validation Engine.
 */

// ---------------------------------------------------------------------------
// Column Types — All supported field data types
// ---------------------------------------------------------------------------

/**
 * Comprehensive list of column types supported by Ion Drive.
 * Each maps to a specific PostgreSQL data type.
 */
export const COLUMN_TYPES = {
  // Text
  text: { pg: 'TEXT', category: 'text', label: 'Text' },
  short_text: { pg: 'VARCHAR(255)', category: 'text', label: 'Short Text' },
  long_text: { pg: 'TEXT', category: 'text', label: 'Long Text' },
  rich_text: { pg: 'TEXT', category: 'text', label: 'Rich Text' },
  email: { pg: 'VARCHAR(320)', category: 'text', label: 'Email' },
  url: { pg: 'VARCHAR(2048)', category: 'text', label: 'URL' },
  phone: { pg: 'VARCHAR(50)', category: 'text', label: 'Phone' },
  slug: { pg: 'VARCHAR(255)', category: 'text', label: 'Slug' },

  // Numbers
  integer: { pg: 'INTEGER', category: 'number', label: 'Integer' },
  big_integer: { pg: 'BIGINT', category: 'number', label: 'Big Integer' },
  decimal: { pg: 'NUMERIC(19,4)', category: 'number', label: 'Decimal' },
  float: { pg: 'DOUBLE PRECISION', category: 'number', label: 'Float' },
  percentage: { pg: 'NUMERIC(5,2)', category: 'number', label: 'Percentage' },
  currency: { pg: 'NUMERIC(19,4)', category: 'number', label: 'Currency' },

  // Boolean
  boolean: { pg: 'BOOLEAN', category: 'boolean', label: 'Boolean' },

  // Date & Time
  date: { pg: 'DATE', category: 'datetime', label: 'Date' },
  datetime: { pg: 'TIMESTAMPTZ', category: 'datetime', label: 'Date & Time' },
  time: { pg: 'TIME', category: 'datetime', label: 'Time' },

  // Identity
  uuid: { pg: 'UUID', category: 'identity', label: 'UUID' },
  auto_increment: { pg: 'SERIAL', category: 'identity', label: 'Auto Increment' },

  // Structured
  json: { pg: 'JSONB', category: 'structured', label: 'JSON' },
  array_text: { pg: 'TEXT[]', category: 'structured', label: 'Text Array' },
  array_integer: { pg: 'INTEGER[]', category: 'structured', label: 'Integer Array' },

  // Enum (stored as VARCHAR, validated by application)
  enum: { pg: 'VARCHAR(255)', category: 'enum', label: 'Single Select' },
  multi_enum: { pg: 'TEXT[]', category: 'enum', label: 'Multi Select' },

  // Special
  rating: { pg: 'SMALLINT', category: 'special', label: 'Rating' },
  color: { pg: 'VARCHAR(7)', category: 'special', label: 'Color' },
  ip_address: { pg: 'INET', category: 'special', label: 'IP Address' },
} as const;

export type ColumnTypeName = keyof typeof COLUMN_TYPES;

export interface ColumnTypeInfo {
  pg: string;
  category: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Relationship Types
// ---------------------------------------------------------------------------

export type RelationshipType = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

// ---------------------------------------------------------------------------
// Data Object Definition (domain model)
// ---------------------------------------------------------------------------

export interface DataObjectDefinition {
  id?: string;
  name: string;
  displayName: string;
  description?: string;
  tableName: string;
  isSystem?: boolean;
  fields: FieldDefinition[];
  relationships?: RelationshipDefinition[];
}

export interface FieldDefinition {
  id?: string;
  name: string;
  displayName: string;
  columnName: string;
  columnType: ColumnTypeName;
  isRequired?: boolean;
  isUnique?: boolean;
  isIndexed?: boolean;
  isPrimary?: boolean;
  isSystem?: boolean;
  defaultValue?: string | null;
  constraints?: FieldConstraints;
  sortOrder?: number;
}

export interface FieldConstraints {
  /** Minimum value (for numbers) or minimum length (for text) */
  min?: number;
  /** Maximum value (for numbers) or maximum length (for text) */
  max?: number;
  /** Regex pattern for validation */
  pattern?: string;
  /** Allowed values for enum types */
  enumValues?: string[];
  /** Custom validation message */
  message?: string;
}

export interface RelationshipDefinition {
  id?: string;
  name: string;
  displayName: string;
  type: RelationshipType;
  sourceObjectName: string;
  targetObjectName: string;
  sourceFieldName?: string;
  targetFieldName?: string;
  cascadeDelete?: boolean;
}

// ---------------------------------------------------------------------------
// Schema Change Operations
// ---------------------------------------------------------------------------

export type SchemaChangeType =
  | 'create_object'
  | 'delete_object'
  | 'rename_object'
  | 'add_field'
  | 'modify_field'
  | 'remove_field'
  | 'rename_field'
  | 'add_relationship'
  | 'remove_relationship'
  | 'add_index'
  | 'remove_index';

export interface SchemaChange {
  type: SchemaChangeType;
  objectName: string;
  details: Record<string, unknown>;
}

export interface ChangeSet {
  id: string;
  description: string;
  changes: SchemaChange[];
  createdAt: Date;
  createdBy?: string;
}

export interface ChangePreview {
  changeSet: ChangeSet;
  sqlStatements: string[];
  warnings: ChangeWarning[];
  errors: ChangeError[];
  isValid: boolean;
}

export interface ChangeWarning {
  change: SchemaChange;
  message: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ChangeError {
  change: SchemaChange;
  message: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Schema State (runtime representation)
// ---------------------------------------------------------------------------

export interface SchemaState {
  objects: Map<string, DataObjectDefinition>;
  relationships: RelationshipDefinition[];
  version: number;
  lastUpdated: Date;
}

// ---------------------------------------------------------------------------
// System field templates — auto-added to every user data object
// ---------------------------------------------------------------------------

export const SYSTEM_FIELDS: FieldDefinition[] = [
  {
    name: 'id',
    displayName: 'ID',
    columnName: 'id',
    columnType: 'uuid',
    isPrimary: true,
    isRequired: true,
    isSystem: true,
    defaultValue: 'gen_random_uuid()',
    sortOrder: -100,
  },
  {
    name: 'created_at',
    displayName: 'Created At',
    columnName: 'created_at',
    columnType: 'datetime',
    isSystem: true,
    defaultValue: 'NOW()',
    sortOrder: -2,
  },
  {
    name: 'updated_at',
    displayName: 'Updated At',
    columnName: 'updated_at',
    columnType: 'datetime',
    isSystem: true,
    defaultValue: 'NOW()',
    sortOrder: -1,
  },
];

/**
 * Physical columns the platform manages automatically. Change events exclude
 * these from their diff so a record's diff only ever reflects business fields
 * (never `updated_at`, and — once actor tracking lands — never `*_by`). This is
 * the single source of truth for that exclusion. See ADR-015.
 */
export const SYSTEM_MANAGED_COLUMNS: ReadonlySet<string> = new Set([
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
]);
