/**
 * Auth module — pluggable authentication, sessions, API keys, and RBAC.
 */

export type {
  AuthProvider,
  AuthPrincipal,
  AuthUser,
  AuthSessionInfo,
  ProviderSession,
} from './types.js';
export { bootstrapAdminFromEnv, resolveAdminBootstrapCredentials } from './admin-bootstrap.js';
export type { AdminBootstrapCredentials, AdminBootstrapDeps } from './admin-bootstrap.js';
export { BETTER_AUTH_TABLES, BetterAuthProvider } from './better-auth-adapter.js';
export type {
  AnonymousAuthOptions,
  BetterAuthProviderOptions,
  CreatedAuthUser,
} from './better-auth-adapter.js';
export {
  ANONYMOUS_CLEANUP_TASK_NAME,
  ANONYMOUS_CLEANUP_TASK_TYPE,
  ANONYMOUS_ROLE_NAME,
  createAnonymousCleanupHandler,
  deriveEmailDomain,
  ensureAnonymousCleanupTask,
  migrateAnonymousUser,
} from './anonymous.js';
export type { AnonymousMigrationSummary, MigrateAnonymousUserDeps } from './anonymous.js';
export { installSessionMiddleware } from './session-middleware.js';
export type { SessionMiddlewareOptions } from './session-middleware.js';
export { ApiKeyManager } from './api-key-manager.js';
export type { ApiKeyPrincipal, CreatedApiKey, ApiKeyMetadata } from './api-key-manager.js';

export * from './rbac/index.js';
