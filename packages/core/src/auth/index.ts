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
export { BetterAuthProvider } from './better-auth-adapter.js';
export type { BetterAuthProviderOptions } from './better-auth-adapter.js';
export { installSessionMiddleware } from './session-middleware.js';
export type { SessionMiddlewareOptions } from './session-middleware.js';
export { ApiKeyManager } from './api-key-manager.js';
export type { ApiKeyPrincipal, CreatedApiKey, ApiKeyMetadata } from './api-key-manager.js';

export * from './rbac/index.js';
