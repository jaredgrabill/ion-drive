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
 *
 * The `bearer` plugin is always mounted (issue #24), so the session token a
 * sign-in returns verifies via `Authorization: Bearer <token>` — on the
 * `/api/auth/*` endpoints and on `getSession()` (which powers `request.auth`
 * and `/api/v1/me`) alike.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { anonymous } from 'better-auth/plugins/anonymous';
import { bearer } from 'better-auth/plugins/bearer';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AuthProvider, ProviderSession } from './types.js';

/**
 * A user as reported by Better Auth's create hook. `isAnonymous` is true for
 * guests minted by the anonymous plugin, so `onUserCreated` consumers can route
 * them (anonymous role) differently from real sign-ups (first-admin bootstrap).
 */
export interface CreatedAuthUser {
  id: string;
  isAnonymous: boolean;
}

/** Config for the optional anonymous (guest) sign-in support (issue #6). */
export interface AnonymousAuthOptions {
  /**
   * Domain used for the placeholder email of anonymous users
   * (`temp-<id>@<domain>`). Defaults to the hostname of `baseURL`.
   */
  emailDomainName?: string;
  /**
   * Called when an anonymous session signs up / signs in with a real
   * credential, **before** Better Auth deletes the anonymous user. This is the
   * data-continuity seam: Ion Drive migrates roles and actor-stamped rows from
   * the anonymous user id to the new user id here. Note Better Auth's model is
   * a *new* user + migration — the user id itself is not preserved.
   */
  onLinkAccount?: (link: { anonymousUserId: string; newUserId: string }) => Promise<void>;
}

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
  onUserCreated?: (user: CreatedAuthUser) => Promise<void>;
  /**
   * When provided and it returns true, sign-up requests are rejected with 403
   * before reaching Better Auth. Evaluated per request so the caller can gate
   * on live state (e.g. "an admin already exists").
   */
  isSignupBlocked?: () => boolean | Promise<boolean>;
  /**
   * Enables Better Auth's `anonymous` plugin (guest sign-in at
   * `POST <basePath>/sign-in/anonymous`). Absent → the plugin is not mounted
   * and the endpoint 404s (`ION_ANONYMOUS_AUTH`, default off).
   */
  anonymous?: AnonymousAuthOptions;
}

/**
 * Builds the underlying Better Auth instance. Kept as a standalone function so
 * `BetterAuthInstance` captures the precise inferred type (the generic default
 * `Auth<BetterAuthOptions>` is not assignable from the specialized instance).
 */
function createAuthInstance(
  options: BetterAuthProviderOptions,
  basePath: string,
  isAdministrativeCreation: () => boolean,
) {
  const isSignupBlocked = options.isSignupBlocked;
  const anonymousOptions = options.anonymous;
  return betterAuth({
    database: options.pool,
    secret: options.secret,
    baseURL: options.baseURL,
    basePath,
    emailAndPassword: { enabled: true, autoSignIn: true },
    trustedOrigins: options.trustedOrigins,
    plugins: [
      // Bearer sessions (issue #24) — always mounted. The `token` that sign-in
      // endpoints return in their JSON body verifies as `Authorization:
      // Bearer <token>`: the plugin's before-hook rewrites a verified bearer
      // header into the session cookie for the rest of the pipeline, so both
      // `/api/auth/*` and our server-side `getSession()` (hence
      // `request.auth` and `/api/v1/me`) resolve bearer-presented sessions
      // identically to cookie ones. This lets a third-party server (e.g. a
      // game's own backend) verify a browser-held session whose HttpOnly
      // cookie the browser JS cannot read. Ion Drive API keys stay
      // unambiguous alongside this: the session middleware routes
      // `Bearer iond_…` to the API-key path by prefix before the provider
      // ever sees the header.
      bearer(),
      // Anonymous (guest) sign-in — config-gated (ION_ANONYMOUS_AUTH). The
      // plugin adds `POST /sign-in/anonymous`, an `isAnonymous` column on the
      // user table (created by the same boot migration runner as every other
      // Better Auth table), and an after-hook that fires `onLinkAccount` when
      // an anonymous session authenticates with a real credential — after
      // which the plugin deletes the anonymous user (its data has been
      // migrated by then).
      ...(anonymousOptions
        ? [
            anonymous({
              emailDomainName: anonymousOptions.emailDomainName,
              onLinkAccount: async ({ anonymousUser, newUser }) => {
                await anonymousOptions.onLinkAccount?.({
                  anonymousUserId: anonymousUser.user.id,
                  newUserId: newUser.user.id,
                });
              },
            }),
          ]
        : []),
    ],
    hooks: {
      // Signup lockout (ION_DISABLE_SIGNUP) is enforced **inside Better Auth's
      // own router** (audit V5): `ctx.path` is the endpoint better-call already
      // matched (e.g. `/sign-up/email`), so this cannot diverge from an outer
      // Fastify prefix check on case/encoding. Any sign-up endpoint is rejected
      // with a 403 before an account is created.
      before: createAuthMiddleware(async (ctx) => {
        if (!isSignupBlocked) return;
        // Administrative creation ({@link BetterAuthProvider.createUser}, the
        // env admin bootstrap) is exempt: it is a pre-listen programmatic call,
        // not a public signup, and must succeed even when the durable lockout
        // marker predates a wiped user table (issue #26 QA). The latch is set
        // only for the duration of that call and no HTTP is served while the
        // bootstrap runs, so the PUBLIC lock is unaffected.
        if (isAdministrativeCreation()) return;
        if (ctx.path === '/sign-up' || ctx.path.startsWith('/sign-up/')) {
          if (await isSignupBlocked()) {
            throw new APIError('FORBIDDEN', { message: 'Signup is disabled on this server' });
          }
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // `isAnonymous` only exists on the record when the anonymous
            // plugin minted the user; Better Auth's hook types don't carry
            // plugin fields, hence the narrow structural read.
            const isAnonymous = (user as { isAnonymous?: boolean | null }).isAnonymous === true;
            await options.onUserCreated?.({ id: user.id, isAnonymous });
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

  /**
   * True while {@link createUser} is executing. Consulted by the signup-lock
   * before-hook so administrative (programmatic, pre-listen) account creation
   * is exempt from the PUBLIC signup lockout. Plain field, not a general
   * bypass: nothing else sets it, and it is always cleared in a `finally`.
   */
  private administrativeCreationActive = false;

  constructor(options: BetterAuthProviderOptions) {
    this.basePath = options.basePath ?? '/api/auth';
    this.auth = createAuthInstance(options, this.basePath, () => this.administrativeCreationActive);
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
      // Signup lockout is enforced inside Better Auth's router via a `before`
      // hook (see createAuthInstance), so there is no fragile prefix check here.
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
        // Set by the anonymous plugin (absent → false). Surfaced so /api/v1/me
        // and RBAC consumers can distinguish guests from registered users.
        isAnonymous: (result.user as { isAnonymous?: boolean | null }).isAnonymous === true,
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
   *
   * Administrative creation: goes through the normal signup pipeline (same
   * hashing, same password policy, same user-created hook) but is exempt from
   * the PUBLIC signup lockout — a bootstrap against a database whose users
   * were wiped after the durable lockout marker was written must still be able
   * to re-create the admin (issue #26 QA). The exemption is scoped to this
   * call via {@link administrativeCreationActive}.
   */
  async createUser(input: { email: string; password: string; name?: string }): Promise<string> {
    this.administrativeCreationActive = true;
    try {
      const res = await this.auth.api.signUpEmail({
        body: { email: input.email, password: input.password, name: input.name ?? input.email },
      });
      return res.user.id;
    } finally {
      this.administrativeCreationActive = false;
    }
  }
}
