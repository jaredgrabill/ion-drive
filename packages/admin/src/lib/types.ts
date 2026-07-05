/** Shared types mirroring the Ion Drive backend API shapes. */

export interface FieldDefinition {
  name: string;
  displayName: string;
  columnName: string;
  columnType: string;
  isRequired?: boolean;
  isUnique?: boolean;
  isIndexed?: boolean;
  isPrimary?: boolean;
  isSystem?: boolean;
  defaultValue?: string | null;
}

export interface RelationshipDefinition {
  name: string;
  displayName: string;
  type: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  sourceObjectName: string;
  targetObjectName: string;
}

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

export interface ObjectSummary {
  name: string;
  displayName: string;
  description?: string;
  tableName: string;
  isSystem: boolean;
  fieldCount: number;
  relationshipCount: number;
}

export interface ColumnType {
  name: string;
  pg: string;
  category: string;
  label: string;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface RecordListResult {
  data: Record<string, unknown>[];
  pagination: PaginationMeta;
}

export interface PermissionGrant {
  resource: string;
  actions: string[];
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: PermissionGrant[];
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  roles: string[];
}

export interface SecretMetadata {
  key: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigEntry {
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
}

export interface ApiKeyMetadata {
  id: string;
  name: string;
  prefix: string;
  userId: string | null;
  roleId: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
  prefix: string;
}

export interface CurrentUser {
  authenticated: boolean;
  via?: 'session' | 'api_key';
  user?: { id: string; email: string; name: string | null } | null;
  userId?: string | null;
  roles?: string[];
}
