/** Shared types mirroring the Ion Drive backend API shapes. */

export interface FieldConstraints {
  /** Minimum value (numbers) or length (text). */
  min?: number;
  /** Maximum value (numbers) or length (text). */
  max?: number;
  /** POSIX regex the value must match. */
  pattern?: string;
  /** Allowed values for select types. */
  enumValues?: string[];
  /** Custom validation message shown to API callers. */
  message?: string;
}

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
  constraints?: FieldConstraints | null;
  sortOrder?: number;
  description?: string | null;
  /** Presentation-only metadata (enum colors, control hints, displayField). */
  uiOptions?: Record<string, unknown> | null;
  /** Provenance: 'user' | 'system' | 'block:<name>' (Phase 10). */
  managedBy?: string;
}

/** Partial update accepted by PATCH /schema/objects/:name/fields/:fieldName. */
export interface FieldModification {
  name?: string;
  displayName?: string;
  description?: string | null;
  uiOptions?: Record<string, unknown> | null;
  columnType?: string;
  isRequired?: boolean;
  isUnique?: boolean;
  isIndexed?: boolean;
  defaultValue?: string | null;
  constraints?: FieldConstraints | null;
  sortOrder?: number;
  backfillValue?: string;
}

export interface RelationshipDefinition {
  name: string;
  displayName: string;
  type: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  sourceObjectName: string;
  targetObjectName: string;
  sourceFieldName?: string;
  junctionTable?: string;
  managedBy?: string;
}

export interface DataObjectDefinition {
  id?: string;
  name: string;
  displayName: string;
  description?: string;
  tableName: string;
  isSystem?: boolean;
  managedBy?: string;
  fields: FieldDefinition[];
  relationships?: RelationshipDefinition[];
}

// --- Schema change previews (Phase 10) ---

export interface ChangeWarning {
  message: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ChangeError {
  message: string;
  code: string;
}

export interface ChangePreview {
  sqlStatements: string[];
  warnings: ChangeWarning[];
  errors: ChangeError[];
  isValid: boolean;
}

// --- Schema drift doctor (Phase 10) ---

export interface DoctorFinding {
  kind:
    | 'unmanaged_table'
    | 'unmanaged_column'
    | 'missing_table'
    | 'missing_column'
    | 'type_mismatch';
  severity: 'info' | 'warning' | 'critical';
  table: string;
  column?: string;
  objectName?: string;
  detail: string;
  suggestedType?: string;
  ignoreKey: string;
}

export interface DoctorReport {
  healthy: boolean;
  findings: DoctorFinding[];
  ignored: string[];
  checkedAt: string;
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

// --- Stats & version (Phase 8) ---

export interface StatsSnapshot {
  objects: number;
  fields: number;
  users: number;
  roles: number;
  apiKeys: number;
  tasks: number;
  blocks: number;
  requests24h: number;
  errors24h: number;
}

export interface TrafficPoint {
  timestamp: string;
  total: number;
  errors: number;
  bySurface: Record<string, number>;
}

export type TrafficPeriod = '1h' | '6h' | '24h' | '7d';

export interface TrafficSummary {
  period: TrafficPeriod;
  bucketMinutes: number;
  points: TrafficPoint[];
  totals: { requests: number; errors: number };
  latency: { p50: number; p95: number; p99: number };
}

export interface ErrorEntry {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  surface: string;
}

export interface VersionInfo {
  name: string;
  version: string;
  uptimeSeconds: number;
  nodeVersion: string;
  features: {
    auth: boolean;
    tasks: boolean;
    blocks: boolean;
    events: boolean;
    metrics: boolean;
    otel: boolean;
  };
}

// --- Logs (Phase 8) ---

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  traceId?: string;
  spanId?: string;
  attributes: Record<string, unknown>;
}

export interface LogQueryParams {
  level?: LogLevel;
  source?: string;
  search?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

// --- Tasks (Phase 5 backend, Phase 8 UI) ---

export interface TaskDef {
  id: string;
  name: string;
  description: string | null;
  type: string;
  schedule: string | null;
  timezone: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  last_run_at: string | null;
  last_status: 'success' | 'failed' | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRun {
  id: string;
  task_id: string;
  status: 'running' | 'success' | 'failed';
  trigger: 'schedule' | 'manual';
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface TaskWithRuns extends TaskDef {
  runs: TaskRun[];
  nextRun: string | null;
}

export interface TaskInput {
  name: string;
  description?: string | null;
  type: string;
  schedule?: string | null;
  timezone?: string | null;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface TaskHandlerInfo {
  type: string;
  description: string;
}

// --- Building blocks (Phase 6 backend, Phase 8 UI) ---

export interface InstalledBlock {
  name: string;
  version: string;
  title: string;
  status: 'installing' | 'installed' | 'failed';
  createdObjects: string[];
  manifest: { description?: string; [key: string]: unknown };
  installedAt: string;
  updatedAt: string;
}
