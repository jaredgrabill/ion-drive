/**
 * @module @ion-drive/core
 *
 * Ion Drive Core — The runtime engine for dynamic data objects,
 * automatic API generation, and LLM-native platform operations.
 */

export { createServer } from './server.js';
export type { CreateServerOptions, IonDriveServer } from './server.js';
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
export { DataService, DataServiceError, listRelationKeys, findRelationKey } from './data/index.js';
export type {
  QueryOptions,
  QueryResult,
  FilterCondition,
  SortOption,
  RelationKey,
} from './data/index.js';

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
  BETTER_AUTH_TABLES,
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
  // Event-bus metric helpers + attribute keys — exported so an external bus
  // implementation (e.g. @ion-drive/plugin-redis) keeps `ion.event.*` parity.
  recordEventPublished,
  recordEventDelivery,
  ION_ATTR,
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
  blockNameSchema,
  blockRefSchema,
  semverRangeSchema,
  semverVersionSchema,
  splitBlockRef,
  dependencyNames,
  evaluateDependencies,
} from './blocks/index.js';
export type { DependencyEvaluation, OutOfRangeDependency } from './blocks/index.js';
export type {
  BlockManifest,
  BlockManifestInput,
  BlockObject,
  BlockRelationship,
  BlockRole,
  BlockStatus,
  BlockActionDeclaration,
  BlockHookDeclaration,
  BlockCodeFile,
  InstalledBlock,
  BlockInstallReport,
} from './blocks/index.js';
export { registerBlockRoutes } from './api/block-routes.js';

// Block registry protocol v1 (ADR-022 / spec-01)
export {
  registryIndexSchema,
  registryBlockSchema,
  registriesDirectorySchema,
  parseRegistryIndex,
  parseRegistryBlock,
  parseRegistriesDirectory,
  RegistryParseError,
  resolveRegistryUrl,
  isPermittedRegistryUrl,
} from './blocks/index.js';
export type {
  RegistryIndex,
  RegistryIndexEntry,
  RegistryBlock,
  RegistryVersionEntry,
  RegistryVersionStatus,
  RegistryAdvisory,
  AdvisorySeverity,
  RegistriesDirectory,
  RegistryDirectoryEntry,
} from './blocks/index.js';

// Block actions + hooks — the vendored-logic seam (Phase 14)
export { ActionRegistry, ACTION_REGISTRY, ActionExecutor, ActionError } from './blocks/index.js';
export type {
  ActionContext,
  ActionDefinition,
  ActionRbac,
  ActionErrorCode,
  DeclaredAction,
  HookContext,
  HookDefinition,
  HookResult,
  HookDelivery,
} from './blocks/index.js';
export { registerHookRoutes } from './api/hook-routes.js';

// Extensibility runtime — service registry + plugin host (Phase 9),
// ambient request/actor context (Phase 12)
export {
  ServiceRegistry,
  ServiceRegistryError,
  serviceToken,
  definePlugin,
  loadPlugins,
  PluginLoadError,
  currentActor,
  currentActorId,
  runWithActor,
} from './runtime/index.js';
export type {
  ServiceToken,
  IonPlugin,
  PluginContext,
  LoadPluginsOptions,
  LoadedPlugins,
  ActorRef,
} from './runtime/index.js';

// Infrastructure provider ports + defaults (Phase 9)
export { CACHE_SERVICE, MemoryCache } from './cache/index.js';
export type { CacheProvider } from './cache/index.js';
export { EMAIL_SERVICE, LogEmailProvider } from './email/index.js';
export type { EmailProvider, EmailMessage, EmailResult } from './email/index.js';
export { LOGGER_SERVICE, PinoLoggerProvider } from './logging/index.js';
export type { LoggerProvider, LogFields } from './logging/index.js';
export {
  STORAGE_SERVICE,
  LocalStorage,
  StorageError,
  normalizeStorageKey,
} from './storage/index.js';
export type {
  StorageProvider,
  StorageObject,
  StorageObjectInfo,
  StoragePutOptions,
  StorageListOptions,
  StorageSignedUrlOptions,
} from './storage/index.js';

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
  // Phase 12: realtime bridge + outbound webhooks + retry/backoff
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF,
  RealtimeBridge,
  WebhookManager,
  WebhookStore,
  WebhookError,
  bootstrapWebhookTable,
  signWebhookPayload,
  generateWebhookSecret,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_CONSUMER_PREFIX,
  WEBHOOK_HANDLER_NAME,
} from './messaging/index.js';
export type {
  MessageBus,
  IonEvent,
  PublishInput,
  CrudEventPayload,
  CrudOperation,
  FieldDiff,
  LinkEventPayload,
  LinkOperation,
  Subscription,
  BusHandler,
  EventContext,
  EventHandlerFn,
  SubscribeOptions,
  BusTransaction,
  RecordWriter,
  DeliveryRow,
  RetryBackoff,
  RealtimeBridgeOptions,
  RealtimeListener,
  WebhookInput,
  WebhookView,
  WebhookRow,
  CreatedWebhook,
} from './messaging/index.js';
export { registerEventRoutes } from './api/event-routes.js';
export { registerWebhookRoutes } from './api/webhook-admin-routes.js';

// Database
export { createSystemDb, createTenantDb } from './db/index.js';
