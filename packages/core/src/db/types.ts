/**
 * Kysely type definitions for Ion Drive's system database tables.
 *
 * These types provide compile-time safety for all operations on
 * Ion Drive's internal metadata tables. Tenant data tables are
 * handled dynamically and do not appear here.
 */

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// ---------------------------------------------------------------------------
// Tenant Database (dynamic)
// ---------------------------------------------------------------------------

/**
 * Tenant data tables are defined at runtime, so their shape is unknown at
 * compile time. We deliberately type the tenant Kysely instance as `any`:
 * correctness is enforced at runtime by the SchemaRegistry and ChangeValidator,
 * not by the type system. See ADR-002.
 */
// biome-ignore lint/suspicious/noExplicitAny: tenant schema is fully dynamic at runtime
export type TenantDatabase = any;

// ---------------------------------------------------------------------------
// System Database Interface (Kysely root type)
// ---------------------------------------------------------------------------

export interface SystemDatabase {
  _ion_objects: IonObjectsTable;
  _ion_fields: IonFieldsTable;
  _ion_relationships: IonRelationshipsTable;
  _ion_migrations: IonMigrationsTable;
  _ion_indexes: IonIndexesTable;
  _ion_config: IonConfigTable;
  _ion_secrets: IonSecretsTable;
  _ion_roles: IonRolesTable;
  _ion_user_roles: IonUserRolesTable;
  _ion_api_keys: IonApiKeysTable;
  _ion_tasks: IonTasksTable;
  _ion_task_runs: IonTaskRunsTable;
  _ion_blocks: IonBlocksTable;
}

// ---------------------------------------------------------------------------
// _ion_objects — Data object (table) definitions
// ---------------------------------------------------------------------------

export interface IonObjectsTable {
  id: Generated<string>;
  name: string;
  display_name: string;
  description: string | null;
  table_name: string;
  is_system: ColumnType<boolean, boolean | undefined, boolean>;
  /** Provenance: 'user' | 'system' | 'block:<name>' (Phase 10 / ADR-017). */
  managed_by: ColumnType<string, string | undefined, string>;
  /** Object-level constraints JSON (`{ uniqueTogether: string[][] }`, issue #9). */
  constraints: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type IonObject = Selectable<IonObjectsTable>;
export type NewIonObject = Insertable<IonObjectsTable>;
export type IonObjectUpdate = Updateable<IonObjectsTable>;

// ---------------------------------------------------------------------------
// _ion_fields — Field (column) definitions
// ---------------------------------------------------------------------------

export interface IonFieldsTable {
  id: Generated<string>;
  object_id: string;
  name: string;
  display_name: string;
  column_name: string;
  column_type: string;
  is_required: ColumnType<boolean, boolean | undefined, boolean>;
  is_unique: ColumnType<boolean, boolean | undefined, boolean>;
  is_indexed: ColumnType<boolean, boolean | undefined, boolean>;
  is_primary: ColumnType<boolean, boolean | undefined, boolean>;
  is_system: ColumnType<boolean, boolean | undefined, boolean>;
  default_value: string | null;
  constraints: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  sort_order: ColumnType<number, number | undefined, number>;
  /** Human/agent-facing field description (Phase 10). */
  description: string | null;
  /** Presentation-only UI metadata bag (Phase 10; rule 2 of ADR-017). */
  ui_options: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  /** Provenance: 'user' | 'system' | 'block:<name>' (Phase 10 / ADR-017). */
  managed_by: ColumnType<string, string | undefined, string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type IonField = Selectable<IonFieldsTable>;
export type NewIonField = Insertable<IonFieldsTable>;
export type IonFieldUpdate = Updateable<IonFieldsTable>;

// ---------------------------------------------------------------------------
// _ion_relationships — Relationship definitions between objects
// ---------------------------------------------------------------------------

export interface IonRelationshipsTable {
  id: Generated<string>;
  name: string;
  display_name: string;
  type: string;
  source_object_id: string;
  target_object_id: string;
  source_field_id: string | null;
  target_field_id: string | null;
  junction_table: string | null;
  junction_source_column: string | null;
  junction_target_column: string | null;
  cascade_delete: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export type IonRelationship = Selectable<IonRelationshipsTable>;
export type NewIonRelationship = Insertable<IonRelationshipsTable>;
export type IonRelationshipUpdate = Updateable<IonRelationshipsTable>;

// ---------------------------------------------------------------------------
// _ion_migrations — Schema change history
// ---------------------------------------------------------------------------

export interface IonMigrationsTable {
  id: Generated<string>;
  version: number;
  description: string | null;
  changes: ColumnType<Record<string, unknown>, string, never>;
  sql_up: string;
  sql_down: string | null;
  applied_at: ColumnType<Date, Date | undefined, never>;
  applied_by: string | null;
}

export type IonMigration = Selectable<IonMigrationsTable>;
export type NewIonMigration = Insertable<IonMigrationsTable>;

// ---------------------------------------------------------------------------
// _ion_indexes — Index definitions
// ---------------------------------------------------------------------------

export interface IonIndexesTable {
  id: Generated<string>;
  object_id: string;
  name: string;
  index_name: string;
  columns: ColumnType<string[], string, string>;
  is_unique: ColumnType<boolean, boolean | undefined, boolean>;
  is_auto: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export type IonIndex = Selectable<IonIndexesTable>;
export type NewIonIndex = Insertable<IonIndexesTable>;

// ---------------------------------------------------------------------------
// _ion_config — Platform configuration key/value store
// ---------------------------------------------------------------------------

export interface IonConfigTable {
  key: string;
  value: ColumnType<unknown, string, string>;
  description: string | null;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type IonConfig = Selectable<IonConfigTable>;

// ---------------------------------------------------------------------------
// _ion_secrets — Encrypted secrets (values stored as AES-256-GCM ciphertext)
// ---------------------------------------------------------------------------

export interface IonSecretsTable {
  key: string;
  encrypted_value: string;
  description: string | null;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type IonSecret = Selectable<IonSecretsTable>;

// ---------------------------------------------------------------------------
// _ion_roles — RBAC roles with an embedded permission set
// ---------------------------------------------------------------------------

export interface IonRolesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  /** Array of { resource, actions[] } permission grants. */
  permissions: ColumnType<PermissionGrant[], string, string>;
  is_system: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * Row-level policy attached to a permission grant (issue #7 / Phase 17).
 * Deliberately small and non-Turing:
 *
 *   - `'all'`  — no row restriction (the default when absent; pre-#7 behavior)
 *   - `'own'`  — only rows whose `created_by` equals the acting principal's id
 *   - `'none'` — the grant allows the action object-level but matches no rows
 *   - a {@link FieldMatchPolicy} — generalizes `own` to any column holding the
 *     actor's id (`equals`) or a set of ids containing it (`contains`)
 */
export type RowPolicy = 'all' | 'own' | 'none' | FieldMatchPolicy;

/**
 * Field-match row policy: a row is in scope when `<field>` equals the acting
 * principal's id (`equals: 'actor.id'`) or — for `multi_enum` (text[]) / `json`
 * array columns — contains it (`contains: 'actor.id'`). Exactly one of
 * `equals`/`contains` must be present, and `'actor.id'` is the only supported
 * binding: the policy language is a lookup, not an expression evaluator.
 */
export interface FieldMatchPolicy {
  /** Field (API name) or physical column name on the object. */
  field: string;
  equals?: 'actor.id';
  contains?: 'actor.id';
}

export interface PermissionGrant {
  /** Object name, or '*' for all objects. */
  resource: string;
  /** Allowed actions (create/read/update/delete/manage). */
  actions: string[];
  /**
   * Optional row-level policy scoping this grant's rows (issue #7). Absent =
   * `'all'` (no restriction — fully backwards compatible). When a principal
   * holds several grants allowing the same action, policies union like the
   * grants themselves do: any unrestricted allowing grant wins.
   */
  rowPolicy?: RowPolicy;
}

export type IonRole = Selectable<IonRolesTable>;
export type NewIonRole = Insertable<IonRolesTable>;
export type IonRoleUpdate = Updateable<IonRolesTable>;

// ---------------------------------------------------------------------------
// _ion_user_roles — Assignment of roles to users (users live in Better Auth)
// ---------------------------------------------------------------------------

export interface IonUserRolesTable {
  user_id: string;
  role_id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export type IonUserRole = Selectable<IonUserRolesTable>;

// ---------------------------------------------------------------------------
// _ion_api_keys — Hashed API keys, optionally bound to a user and/or role
// ---------------------------------------------------------------------------

export interface IonApiKeysTable {
  id: Generated<string>;
  name: string;
  key_hash: string;
  prefix: string;
  user_id: string | null;
  role_id: string | null;
  last_used_at: ColumnType<Date | null, never, Date>;
  expires_at: Date | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export type IonApiKey = Selectable<IonApiKeysTable>;

// ---------------------------------------------------------------------------
// _ion_tasks — Scheduled/background task definitions (Phase 5)
// ---------------------------------------------------------------------------

export interface IonTasksTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  /** Handler type: 'log' | 'http_request' | 'noop' | … (see tasks/task-runner). */
  type: string;
  /** Cron expression (croner syntax); null means the task runs only on demand. */
  schedule: string | null;
  /** IANA timezone the cron schedule is evaluated in; null = server local. */
  timezone: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** Handler-specific configuration (URL/method/headers for http_request, etc.). */
  config: ColumnType<Record<string, unknown>, string, string>;
  last_run_at: ColumnType<Date | null, never, Date | null>;
  /** Terminal status of the most recent run: 'success' | 'failed' | null. */
  last_status: ColumnType<string | null, never, string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type IonTask = Selectable<IonTasksTable>;
export type NewIonTask = Insertable<IonTasksTable>;
export type IonTaskUpdate = Updateable<IonTasksTable>;

// ---------------------------------------------------------------------------
// _ion_task_runs — Execution history for tasks (Phase 5)
// ---------------------------------------------------------------------------

export interface IonTaskRunsTable {
  id: Generated<string>;
  task_id: string;
  /** 'running' | 'success' | 'failed'. */
  status: string;
  /** How the run was triggered: 'schedule' | 'manual'. */
  trigger: string;
  started_at: ColumnType<Date, Date | undefined, never>;
  finished_at: Date | null;
  duration_ms: number | null;
  /** Handler output (truncated) as JSON, or null. */
  result: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  error: string | null;
}

export type IonTaskRun = Selectable<IonTaskRunsTable>;
export type NewIonTaskRun = Insertable<IonTaskRunsTable>;
export type IonTaskRunUpdate = Updateable<IonTaskRunsTable>;

// ---------------------------------------------------------------------------
// _ion_blocks — Installed building-block ledger (Phase 6)
// ---------------------------------------------------------------------------

export interface IonBlocksTable {
  /** Block identifier (e.g. 'crm') — the primary key. */
  name: string;
  version: string;
  title: string;
  /** 'installing' | 'installed' | 'failed'. */
  status: string;
  /** Object names this block created, used for clean uninstall. */
  created_objects: ColumnType<string[], string, string>;
  /** Full manifest snapshot as installed, so the consumer owns their copy. */
  manifest: ColumnType<Record<string, unknown>, string, string>;
  // Client-asserted install provenance (spec-04) — null for bare installs.
  /** `sha256:<hex>` the installing client computed over the artifact bytes. */
  artifact_digest: string | null;
  /** Registry namespace the block came from (e.g. '@ion'). */
  source_registry: string | null;
  /** The exact artifact URL. */
  source_url: string | null;
  /** Publisher identity (e.g. 'github.com/jaredgrabill/ion-drive-blocks'). */
  publisher: string | null;
  /** Whether the installing client verified a sigstore attestation. */
  attested: boolean | null;
  /** Trust tier the client computed: 'official' | 'verified' | 'community'. */
  trust_tier: string | null;
  installed_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type IonBlock = Selectable<IonBlocksTable>;
export type NewIonBlock = Insertable<IonBlocksTable>;
export type IonBlockUpdate = Updateable<IonBlocksTable>;
