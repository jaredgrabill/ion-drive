/**
 * Auth abstraction for Ion Drive.
 *
 * Better Auth is the default provider (see better-auth-adapter.ts), but all of
 * Ion Drive talks to auth through the `AuthProvider` interface so a different
 * provider (WorkOS, Auth0, Clerk) can be swapped in without touching the rest
 * of the platform. See ADR-003 / ADR-010.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  /**
   * True for guest users minted by anonymous sign-in (ION_ANONYMOUS_AUTH).
   * Optional so providers without a guest concept need not report it.
   */
  isAnonymous?: boolean;
}

export interface AuthSessionInfo {
  id: string;
  expiresAt: Date;
}

/**
 * The authenticated principal attached to each request (or `null` if anonymous).
 * A principal is either an interactive user (via session) or a machine (via API
 * key). RBAC resolves effective roles from `userId` and/or `roleId`.
 */
export interface AuthPrincipal {
  via: 'session' | 'api_key';
  userId: string | null;
  user: AuthUser | null;
  session: AuthSessionInfo | null;
  apiKeyId: string | null;
  /** Explicit role binding (used by API keys). */
  roleId: string | null;
}

/** The subset of a principal a provider can produce from a session. */
export interface ProviderSession {
  user: AuthUser;
  session: AuthSessionInfo;
}

/**
 * Pluggable authentication provider. Implementations own user storage, login
 * flows, and session validation; Ion Drive owns RBAC and API keys on top.
 */
export interface AuthProvider {
  readonly name: string;

  /** One-time setup (e.g. run migrations to create the provider's tables). */
  initialize(): Promise<void>;

  /**
   * Registers the provider's HTTP endpoints (login, logout, callbacks, …) on the
   * given Fastify instance. Implementations should encapsulate any body-parser
   * changes so they do not leak to the rest of the server.
   */
  registerRoutes(fastify: FastifyInstance): Promise<void>;

  /** Resolves the current session from request headers, or `null`. */
  getSession(headers: IncomingHttpHeaders): Promise<ProviderSession | null>;

  /**
   * Names of database tables this provider owns (users, sessions, tokens, …).
   * The schema drift doctor treats these as system-owned so they are not
   * reported as unmanaged drift. Optional — a provider that stores nothing in
   * the tenant database (e.g. a fully external IdP) can omit it.
   */
  getManagedTables?(): string[];
}
