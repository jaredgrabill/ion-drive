/**
 * Better Auth provider — the default AuthProvider implementation (ADR-003).
 *
 * Wraps a Better Auth instance (email/password by default) and adapts it to the
 * Ion Drive `AuthProvider` interface. Better Auth manages its own tables
 * (user/session/account/verification); we create them at startup via its
 * programmatic migration runner so a fresh database is ready with no CLI step.
 *
 * HTTP endpoints are mounted at `/api/auth/*` inside an encapsulated Fastify
 * scope, where we disable JSON body parsing so Better Auth's handler can read
 * the raw request stream.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AuthProvider, ProviderSession } from './types.js';

export interface BetterAuthProviderOptions {
  /** pg Pool used by Better Auth for its own tables. */
  pool: pg.Pool;
  /** Secret used to sign sessions/tokens (>= 32 chars). */
  secret: string;
  /** Public base URL of the server (e.g. http://localhost:3000). */
  baseURL: string;
  /** Origins allowed to use auth endpoints (admin console, etc.). */
  trustedOrigins?: string[];
  /** Base path for auth routes. Defaults to `/api/auth`. */
  basePath?: string;
  /** Called after a new user is created — used to auto-grant the first admin. */
  onUserCreated?: (userId: string) => Promise<void>;
}

/**
 * Builds the underlying Better Auth instance. Kept as a standalone function so
 * `BetterAuthInstance` captures the precise inferred type (the generic default
 * `Auth<BetterAuthOptions>` is not assignable from the specialized instance).
 */
function createAuthInstance(options: BetterAuthProviderOptions, basePath: string) {
  return betterAuth({
    database: options.pool,
    secret: options.secret,
    baseURL: options.baseURL,
    basePath,
    emailAndPassword: { enabled: true, autoSignIn: true },
    trustedOrigins: options.trustedOrigins,
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await options.onUserCreated?.(user.id);
          },
        },
      },
    },
  });
}

type BetterAuthInstance = ReturnType<typeof createAuthInstance>;

/**
 * Tables Better Auth creates and manages in the tenant database (core tables
 * plus those of the common plugins). Reported via `getManagedTables()` so the
 * schema drift doctor treats them as system-owned rather than unmanaged drift.
 */
export const BETTER_AUTH_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'jwks',
  'passkey',
  'two_factor',
  'organization',
  'member',
  'invitation',
] as const;

export class BetterAuthProvider implements AuthProvider {
  readonly name = 'better-auth';
  readonly auth: BetterAuthInstance;
  private readonly nodeHandler: (req: unknown, res: unknown) => void;
  private readonly basePath: string;

  constructor(options: BetterAuthProviderOptions) {
    this.basePath = options.basePath ?? '/api/auth';
    this.auth = createAuthInstance(options, this.basePath);
    this.nodeHandler = toNodeHandler(this.auth) as (req: unknown, res: unknown) => void;
  }

  async initialize(): Promise<void> {
    // Create/upgrade Better Auth's tables without the CLI.
    const { runMigrations } = await getMigrations(this.auth.options);
    await runMigrations();
  }

  async registerRoutes(fastify: FastifyInstance): Promise<void> {
    const basePath = this.basePath;
    const nodeHandler = this.nodeHandler;
    await fastify.register(async (scope) => {
      // Better Auth reads the raw request body, so stop Fastify from consuming it.
      scope.addContentTypeParser('application/json', {}, (_req, _payload, done) => done(null));
      scope.all(`${basePath}/*`, async (request, reply) => {
        reply.hijack();
        nodeHandler(request.raw, reply.raw);
      });
    });
  }

  /** Tables Better Auth owns — the drift doctor treats these as system-owned. */
  getManagedTables(): string[] {
    return [...BETTER_AUTH_TABLES];
  }

  async getSession(headers: IncomingHttpHeaders): Promise<ProviderSession | null> {
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!result?.user || !result.session) return null;
    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name ?? null,
        emailVerified: Boolean(result.user.emailVerified),
      },
      session: {
        id: result.session.id,
        expiresAt: new Date(result.session.expiresAt),
      },
    };
  }

  /**
   * Creates a user directly (used for first-run seeding of the admin account).
   * Returns the new user's id, or throws if creation fails.
   */
  async createUser(input: { email: string; password: string; name?: string }): Promise<string> {
    const res = await this.auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name ?? input.email },
    });
    return res.user.id;
  }
}
