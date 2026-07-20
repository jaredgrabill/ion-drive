/**
 * Env-var admin bootstrap (issue #26).
 *
 * `ION_ADMIN_EMAIL` + `ION_ADMIN_PASSWORD` (or `ION_ADMIN_PASSWORD_FILE` for
 * secret mounts) let a deployment create its admin account **at boot** instead
 * of racing to be the first signup: on a database with zero credentialed
 * users, boot creates the account through the normal Better Auth signup path
 * (same hashing, same password policy, same first-admin grant) and — because
 * setting the vars flips `ION_DISABLE_SIGNUP`'s default to `true` (see
 * `loadConfig`) — public signup starts locked. No exposure window, no second
 * trip into the host's env settings.
 *
 * On a database that already has users the variables are ignored with a single
 * info line, so they are safe to leave set permanently. Runs inside
 * `createServer()` — strictly before the HTTP server listens — so no external
 * request can win a race against the zero-users check.
 *
 * The password value is never logged; failures name the variable, not the
 * secret.
 */

import { readFileSync } from 'node:fs';
import { APIError } from 'better-auth/api';
import { type Kysely, sql } from 'kysely';
import type { IonDriveConfig } from '../config/index.js';
import type { RoleManager } from './rbac/role-manager.js';

/** Resolved bootstrap credentials, or `undefined` when the vars are unset. */
export interface AdminBootstrapCredentials {
  email: string;
  password: string;
}

/** The slice of `BetterAuthProvider` the bootstrap needs (eases testing). */
export interface AdminBootstrapAuthProvider {
  createUser(input: { email: string; password: string; name?: string }): Promise<string>;
}

export interface AdminBootstrapDeps {
  /** Tenant DB handle — Better Auth's `user` table lives there. */
  tenantDb: Kysely<Record<string, unknown>>;
  authProvider: AdminBootstrapAuthProvider;
  roleManager: RoleManager;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Resolves the admin bootstrap credentials from config, or `undefined` when
 * env bootstrap is not configured. Throws a clear boot error on partial or
 * ambiguous configuration — a half-set bootstrap silently falling back to
 * first-signup-wins would defeat the point of setting the vars.
 *
 * `ION_ADMIN_PASSWORD_FILE` reads the file's contents and trims surrounding
 * whitespace (secret mounts routinely append a trailing newline).
 */
export function resolveAdminBootstrapCredentials(
  config: Pick<IonDriveConfig, 'adminEmail' | 'adminPassword' | 'adminPasswordFile'>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): AdminBootstrapCredentials | undefined {
  const { adminEmail, adminPassword, adminPasswordFile } = config;
  if (adminEmail === undefined && adminPassword === undefined && adminPasswordFile === undefined) {
    return undefined;
  }
  if (adminPassword !== undefined && adminPasswordFile !== undefined) {
    throw new Error(
      'Admin bootstrap: set either ION_ADMIN_PASSWORD or ION_ADMIN_PASSWORD_FILE, not both.',
    );
  }
  if (adminEmail === undefined) {
    throw new Error(
      'Admin bootstrap: ION_ADMIN_PASSWORD / ION_ADMIN_PASSWORD_FILE is set but ION_ADMIN_EMAIL is not. Set both (or neither, to keep first-signup-wins bootstrap).',
    );
  }
  let password: string;
  if (adminPasswordFile !== undefined) {
    try {
      password = readFile(adminPasswordFile).trim();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Admin bootstrap: cannot read ION_ADMIN_PASSWORD_FILE (${adminPasswordFile}): ${reason}`,
      );
    }
    if (password === '') {
      throw new Error(
        `Admin bootstrap: ION_ADMIN_PASSWORD_FILE (${adminPasswordFile}) is empty after trimming whitespace.`,
      );
    }
  } else if (adminPassword !== undefined) {
    password = adminPassword;
  } else {
    throw new Error(
      'Admin bootstrap: ION_ADMIN_EMAIL is set but no password is — set ION_ADMIN_PASSWORD or ION_ADMIN_PASSWORD_FILE (or unset ION_ADMIN_EMAIL to keep first-signup-wins bootstrap).',
    );
  }
  return { email: adminEmail, password };
}

/**
 * Counts credentialed (non-anonymous) accounts in Better Auth's `user` table.
 * Guests minted by `ION_ANONYMOUS_AUTH` don't count — a server that has only
 * ever seen anonymous visitors still has no way in and should bootstrap its
 * admin. The `isAnonymous` column only exists when the anonymous plugin has
 * ever been mounted, so probe for it first.
 */
async function countCredentialedUsers(db: Kysely<Record<string, unknown>>): Promise<number> {
  const probe = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'user' AND column_name = 'isAnonymous'
    ) AS "present"
  `.execute(db);
  const hasAnonymousColumn = probe.rows[0]?.present === true;
  const count = hasAnonymousColumn
    ? await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM "user" WHERE "isAnonymous" IS NOT TRUE`.execute(db)
    : await sql<{ n: number }>`SELECT count(*)::int AS n FROM "user"`.execute(db);
  return count.rows[0]?.n ?? 0;
}

/**
 * Creates the env-configured admin account on a fresh database, exactly like
 * a first signup would: through the auth provider's signup path (Better Auth
 * hashing + its password policy) so the account behaves like any other, with
 * the first-admin grant riding the same user-created hook. No-ops with one
 * info line when credentialed users already exist. Must be called after the
 * auth provider's tables exist and before the server listens.
 */
export async function bootstrapAdminFromEnv(
  config: IonDriveConfig,
  deps: AdminBootstrapDeps,
): Promise<void> {
  const credentials = resolveAdminBootstrapCredentials(config);
  if (!credentials) return;
  const { tenantDb, authProvider, roleManager, log } = deps;

  const existing = await countCredentialedUsers(tenantDb);
  if (existing > 0) {
    log.info(
      `Admin bootstrap: ${existing} user(s) already exist — ION_ADMIN_EMAIL ignored (safe to leave set)`,
    );
    return;
  }

  let userId: string;
  try {
    userId = await authProvider.createUser({
      email: credentials.email,
      password: credentials.password,
      name: credentials.email,
    });
  } catch (err) {
    // Surface Better Auth's own signup-policy rejection (e.g. password too
    // short) as a boot failure naming the variable — never the value.
    if (err instanceof APIError) {
      const detail = (err.body as { message?: string } | undefined)?.message ?? err.message;
      throw new Error(
        `Admin bootstrap: the auth provider rejected the ION_ADMIN_EMAIL/ION_ADMIN_PASSWORD credentials: ${detail}`,
      );
    }
    throw err;
  }

  // The signup path's user-created hook already ran grantAdminIfFirstUser
  // (this was the only user, so it won). The explicit assign is an idempotent
  // backstop for the edge where the durable bootstrap marker predates a wiped
  // user table: grantAdminIfFirstUser sees the marker and declines, and
  // createUser itself is exempt from the public signup lockout for exactly
  // this reason (administrative pre-listen creation — see the adapter), so
  // the recreated admin lands here and must be granted explicitly.
  const adminRole = await roleManager.getByName('admin');
  if (adminRole) {
    await roleManager.assign(userId, adminRole.id);
  } else {
    log.warn('Admin bootstrap: admin role not found — account created without a role grant');
  }

  log.info(
    `Admin bootstrap: created admin account ${credentials.email} from environment; public signup is ${
      config.disableSignup
        ? 'locked (ION_DISABLE_SIGNUP)'
        : 'OPEN (ION_DISABLE_SIGNUP=false was set explicitly)'
    }`,
  );
}
