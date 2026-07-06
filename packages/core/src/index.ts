/**
 * @module @ionshift/ion-drive-core
 *
 * Ion Drive Core — The runtime engine for dynamic data objects,
 * automatic API generation, and LLM-native platform operations.
 */

export { createServer } from './server.js';
export { loadConfig } from './config/index.js';
export type { IonDriveConfig } from './config/index.js';

// Schema engine
export { SchemaManager } from './schema/index.js';
export { SchemaRegistry } from './schema/index.js';
export { MetadataStore } from './schema/index.js';
export { DdlExecutor } from './schema/index.js';
export { ChangeValidator } from './schema/index.js';
export { COLUMN_TYPES, SYSTEM_FIELDS } from './schema/index.js';
export type {
  DataObjectDefinition,
  FieldDefinition,
  FieldConstraints,
  FieldModification,
  ManagedBy,
  RelationshipDefinition,
  ColumnTypeName,
  SchemaState,
  ChangePreview,
  ChangeSet,
} from './schema/index.js';
export { assessTypeChange, managedByBlock } from './schema/index.js';
export { diffSnapshot, exportSnapshot, applySnapshot, SchemaDoctor } from './schema/index.js';
export type {
  SchemaSnapshot,
  SnapshotDiffEntry,
  DoctorFinding,
  DoctorReport,
} from './schema/index.js';

// Data access
export { DataService, DataServiceError } from './data/index.js';
export type { QueryOptions, QueryResult, FilterCondition, SortOption } from './data/index.js';

// API surface (REST, OpenAPI, GraphQL)
export { registerSchemaRoutes } from './api/schema-routes.js';
export { registerDataRoutes } from './api/data-routes.js';
export { registerOpenApiRoutes } from './api/openapi-routes.js';
export { registerGraphQLRoutes } from './api/graphql/plugin.js';
export { buildGraphQLSchema } from './api/graphql/schema-builder.js';

// MCP server
export { createMcpServer } from './mcp/server.js';
export { registerMcpRoutes } from './mcp/plugin.js';

// Auth, RBAC, and API keys
export {
  BetterAuthProvider,
  ApiKeyManager,
  RoleManager,
  PermissionEngine,
  installSessionMiddleware,
  installRbacEnforcement,
  requirePermission,
  DEFAULT_ROLES,
} from './auth/index.js';
export type {
  AuthProvider,
  AuthPrincipal,
  AuthUser,
  Action,
  PermissionGrant,
} from './auth/index.js';

// Config, secrets, encryption
export { Encryptor, generateEncryptionKey, SecretsManager, ConfigStore } from './config/index.js';
export { registerAdminRoutes } from './api/admin-routes.js';

// Observability (telemetry)
export {
  startTelemetry,
  installRequestTracing,
  createOtelLogStream,
  recordSchemaChange,
  recordTaskRun,
  LogBuffer,
  createLogBufferStream,
  TrafficStats,
} from './telemetry/index.js';
export type {
  TelemetryHandle,
  LogEntry,
  LogLevel,
  LogQuery,
  TrafficPeriod,
  TrafficSummary,
  ErrorEntry,
} from './telemetry/index.js';
export { registerStatsRoutes } from './api/stats-routes.js';
export { registerLogRoutes } from './api/log-routes.js';

// Scheduled tasks
export {
  TaskEngine,
  TaskEngineError,
  TaskRunner,
  TaskScheduler,
  TaskStore,
} from './tasks/index.js';
export type {
  TaskHandler,
  TaskContext,
  TaskInput,
  TaskPatch,
  TaskTrigger,
  TaskHandlerResult,
} from './tasks/index.js';
export { registerTaskRoutes } from './api/task-routes.js';

// Building blocks (Phase 6)
export {
  BlockEngine,
  BlockEngineError,
  BlockInstaller,
  BlockInstallError,
  BlockStore,
  BlockManifestError,
  parseManifest,
  blockManifestSchema,
} from './blocks/index.js';
export type {
  BlockManifest,
  BlockManifestInput,
  BlockObject,
  BlockRelationship,
  BlockRole,
  BlockStatus,
  InstalledBlock,
  BlockInstallReport,
} from './blocks/index.js';
export { registerBlockRoutes } from './api/block-routes.js';

// Extensibility runtime — service registry + plugin host (Phase 9)
export {
  ServiceRegistry,
  ServiceRegistryError,
  serviceToken,
  definePlugin,
  loadPlugins,
  PluginLoadError,
} from './runtime/index.js';
export type {
  ServiceToken,
  IonPlugin,
  PluginContext,
  LoadPluginsOptions,
  LoadedPlugins,
} from './runtime/index.js';

// Infrastructure provider ports + defaults (Phase 9)
export { CACHE_SERVICE, MemoryCache } from './cache/index.js';
export type { CacheProvider } from './cache/index.js';
export { EMAIL_SERVICE, LogEmailProvider } from './email/index.js';
export type { EmailProvider, EmailMessage, EmailResult } from './email/index.js';
export { LOGGER_SERVICE, PinoLoggerProvider } from './logging/index.js';
export type { LoggerProvider, LogFields } from './logging/index.js';

// Message bus (Phase 9)
export {
  MESSAGE_BUS,
  OutboxBus,
  NoopBus,
  EventDispatcher,
  EventStore,
  bootstrapEventTables,
  computeDiff,
  topicMatches,
  logEventHandler,
  createPersistEventHandler,
} from './messaging/index.js';
export type {
  MessageBus,
  IonEvent,
  PublishInput,
  CrudEventPayload,
  CrudOperation,
  FieldDiff,
  Subscription,
  BusHandler,
  EventContext,
  RecordWriter,
} from './messaging/index.js';

// Database
export { createSystemDb, createTenantDb } from './db/index.js';
