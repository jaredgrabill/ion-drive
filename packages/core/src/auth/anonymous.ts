/**
 * Anonymous (guest) auth support (issue #6) — the Ion Drive side of Better
 * Auth's `anonymous` plugin.
 *
 * The plugin itself (enabled via `ION_ANONYMOUS_AUTH`, see the Better Auth
 * adapter) provides the endpoint (`POST /api/auth/sign-in/anonymous`), the
 * `isAnonymous` user column, and the `onLinkAccount` hook. This module owns
 * what happens *around* it:
 *
 *  - **Identity continuity** ({@link migrateAnonymousUser}). Better Auth's
 *    upgrade model is *account-migration*, not id-preservation: when a guest
 *    signs up with a real credential a **new** user row is created, the
 *    `onLinkAccount` hook fires, and the anonymous user is deleted. So Ion
 *    Drive migrates everything it keys on the user id — role assignments
 *    (`_ion_user_roles`), API-key ownership (`_ion_api_keys.user_id`), and the
 *    `created_by`/`updated_by` actor stamps on every data object — from the
 *    anonymous id to the new id, inside the hook (i.e. before the deletion).
 *  - **The guest role**: anonymous users are auto-assigned the seeded
 *    `anonymous` role (empty grants by default; admins edit it like any other
 *    role). On upgrade the guest keeps explicitly granted roles and drops
 *    `anonymous`.
 *  - **TTL cleanup** ({@link createAnonymousCleanupHandler} +
 *    {@link ensureAnonymousCleanupTask}): a task-engine handler and a seeded,
 *    **disabled-by-default** scheduled task that deletes never-upgraded guests
 *    older than `maxAgeDays`.
 */

import { type Kysely, sql } from 'kysely';
import type { SystemDatabase, TenantDatabase } from '../db/types.js';
import type { DataObjectDefinition } from '../schema/types.js';
import type { TaskEngine } from '../tasks/index.js';
import type { TaskHandler } from '../tasks/task-types.js';
import { ANONYMOUS_ROLE_NAME } from './rbac/policy-types.js';
import type { RoleManager } from './rbac/role-manager.js';

export { ANONYMOUS_ROLE_NAME };

/** Name of the seeded (disabled) TTL-cleanup task definition. */
export const ANONYMOUS_CLEANUP_TASK_NAME = 'anonymous-user-cleanup';

/** Handler type for the TTL cleanup (see the task engine's handler registry). */
export const ANONYMOUS_CLEANUP_TASK_TYPE = 'anonymous_cleanup';

/** Minimal logging seam so this module doesn't depend on Fastify/pino types. */
export interface AnonymousAuthLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Derives the placeholder-email domain for anonymous users from the server's
 * public base URL (`https://api.example.com` → `api.example.com`). Returns
 * undefined on an unparsable URL so the plugin falls back to its default.
 */
export function deriveEmailDomain(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}

export interface MigrateAnonymousUserDeps {
  systemDb: Kysely<SystemDatabase>;
  tenantDb: Kysely<TenantDatabase>;
  roleManager: RoleManager;
  /** Live object list (SchemaManager.listObjects) — actor stamps live per table. */
  listObjects: () => DataObjectDefinition[];
  logger: AnonymousAuthLogger;
}

export interface AnonymousMigrationSummary {
  /** Names of non-anonymous roles carried over to the new user. */
  rolesCarried: string[];
  /** API keys re-owned (`_ion_api_keys.user_id`). */
  apiKeysMoved: number;
  /** Total data rows whose `created_by` and/or `updated_by` was re-stamped. */
  rowsRestamped: number;
}

/**
 * Migrates everything Ion Drive keys on a user id from the anonymous user to
 * the newly registered user. Runs inside the plugin's `onLinkAccount` hook,
 * before Better Auth deletes the anonymous user.
 *
 * What carries over: role assignments (minus the `anonymous` role — the new
 * user is a regular signup and gets whatever regular signups get), API-key
 * ownership, and `created_by`/`updated_by` stamps on every data object.
 *
 * What does NOT carry over (documented, deliberate): the user id itself (the
 * anonymous row is deleted by the plugin), already-published event payloads in
 * `_ion_events` (the outbox is an immutable history — its `actor.userId`
 * snapshots remain the guest id), and `_ion_migrations.applied_by` provenance.
 *
 * Errors propagate: a failed migration fails the sign-up request loudly rather
 * than silently orphaning the guest's data.
 */
export async function migrateAnonymousUser(
  deps: MigrateAnonymousUserDeps,
  fromUserId: string,
  toUserId: string,
): Promise<AnonymousMigrationSummary> {
  const { systemDb, tenantDb, roleManager, listObjects, logger } = deps;

  // 1) Roles: carry explicit grants, drop the `anonymous` role. `assign` is
  //    idempotent (ON CONFLICT DO NOTHING), so overlap with roles the new user
  //    already holds is harmless.
  const roles = await roleManager.getRolesForUser(fromUserId);
  const carried = roles.filter((r) => r.name !== ANONYMOUS_ROLE_NAME);
  for (const role of carried) {
    await roleManager.assign(toUserId, role.id);
  }
  await systemDb.deleteFrom('_ion_user_roles').where('user_id', '=', fromUserId).execute();

  // 2) API keys bound to the guest follow the account.
  const keyResult = await systemDb
    .updateTable('_ion_api_keys')
    .set({ user_id: toUserId })
    .where('user_id', '=', fromUserId)
    .executeTakeFirst();
  const apiKeysMoved = Number(keyResult.numUpdatedRows ?? 0n);

  // 3) Actor stamps on every data object. The columns are plain text (no FK to
  //    the auth user table), so a straight UPDATE per column is sufficient and
  //    keeps rows addressable by the surviving id.
  let rowsRestamped = 0;
  for (const object of listObjects()) {
    const hasCreatedBy = object.fields.some((f) => f.columnName === 'created_by');
    const hasUpdatedBy = object.fields.some((f) => f.columnName === 'updated_by');
    if (!hasCreatedBy && !hasUpdatedBy) continue;
    if (hasCreatedBy) {
      const res = await sql`
        UPDATE ${sql.id(object.tableName)}
        SET created_by = ${toUserId}
        WHERE created_by = ${fromUserId}
      `.execute(tenantDb);
      rowsRestamped += Number(res.numAffectedRows ?? 0n);
    }
    if (hasUpdatedBy) {
      const res = await sql`
        UPDATE ${sql.id(object.tableName)}
        SET updated_by = ${toUserId}
        WHERE updated_by = ${fromUserId}
      `.execute(tenantDb);
      rowsRestamped += Number(res.numAffectedRows ?? 0n);
    }
  }

  const summary: AnonymousMigrationSummary = {
    rolesCarried: carried.map((r) => r.name),
    apiKeysMoved,
    rowsRestamped,
  };
  logger.info(
    `Anonymous user ${fromUserId} upgraded to ${toUserId}: ` +
      `${summary.rolesCarried.length} role(s) carried, ${apiKeysMoved} API key(s) moved, ` +
      `${rowsRestamped} row stamp(s) migrated`,
  );
  return summary;
}

// ---------------------------------------------------------------------------
// TTL cleanup for never-upgraded guests
// ---------------------------------------------------------------------------

/** Default age (days) after which a never-upgraded guest is deleted. */
export const ANONYMOUS_CLEANUP_DEFAULT_MAX_AGE_DAYS = 30;

/**
 * Resolves the cleanup task's `maxAgeDays` config: a positive finite number of
 * days, else the default. Exported for unit tests.
 */
export function resolveCleanupMaxAgeDays(config: Record<string, unknown> | undefined): number {
  const raw = config?.maxAgeDays;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  return ANONYMOUS_CLEANUP_DEFAULT_MAX_AGE_DAYS;
}

/**
 * Task handler that deletes anonymous users (and their sessions and role
 * assignments) whose account is older than `config.maxAgeDays` (default 30).
 * A guest who upgraded is no longer `isAnonymous`, so upgraded accounts are
 * never touched. Registered whenever the task engine boots so a stored task
 * definition always validates; if anonymous auth has never been enabled the
 * `isAnonymous` column doesn't exist and the run reports `skipped`.
 */
export function createAnonymousCleanupHandler(deps: {
  tenantDb: Kysely<TenantDatabase>;
  systemDb: Kysely<SystemDatabase>;
}): TaskHandler {
  return {
    type: ANONYMOUS_CLEANUP_TASK_TYPE,
    description:
      'Deletes anonymous (guest) users that never upgraded to a real account after ' +
      '`maxAgeDays` days (default 30), including their sessions and role assignments.',
    async run(ctx) {
      const maxAgeDays = resolveCleanupMaxAgeDays(ctx.task.config);
      const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

      // Better Auth's Kysely adapter creates camelCase columns ("isAnonymous",
      // "createdAt", "userId") — hence the quoted identifiers.
      let staleIds: string[];
      try {
        const stale = await sql<{ id: string }>`
          SELECT id FROM ${sql.id('user')}
          WHERE ${sql.id('isAnonymous')} = true AND ${sql.id('createdAt')} < ${cutoff}
        `.execute(deps.tenantDb);
        staleIds = stale.rows.map((r) => r.id);
      } catch (err) {
        // 42703 = undefined column: anonymous auth was never enabled on this
        // database, so there is nothing to clean up.
        if ((err as { code?: string }).code === '42703') {
          ctx.logger.info('anonymous_cleanup: isAnonymous column not present — nothing to do');
          return { skipped: true, reason: 'anonymous auth never enabled' };
        }
        throw err;
      }

      if (staleIds.length === 0) return { deleted: 0, maxAgeDays };

      await sql`
        DELETE FROM ${sql.id('session')} WHERE ${sql.id('userId')} = ANY(${staleIds})
      `.execute(deps.tenantDb);
      await deps.systemDb.deleteFrom('_ion_user_roles').where('user_id', 'in', staleIds).execute();
      await sql`
        DELETE FROM ${sql.id('user')} WHERE id = ANY(${staleIds})
      `.execute(deps.tenantDb);

      ctx.logger.info(
        `anonymous_cleanup: deleted ${staleIds.length} guest user(s) older than ${maxAgeDays}d`,
      );
      return { deleted: staleIds.length, maxAgeDays };
    },
  };
}

/**
 * Seeds the disabled-by-default cleanup task definition (idempotent by name).
 * Only called when anonymous auth is enabled; admins flip `enabled` (and tune
 * `maxAgeDays` / the schedule) from the Tasks console or REST API.
 */
export async function ensureAnonymousCleanupTask(taskEngine: TaskEngine): Promise<void> {
  if (await taskEngine.store.getByName(ANONYMOUS_CLEANUP_TASK_NAME)) return;
  await taskEngine.create({
    name: ANONYMOUS_CLEANUP_TASK_NAME,
    description:
      'Deletes never-upgraded anonymous (guest) users after maxAgeDays days. ' +
      'Seeded by ION_ANONYMOUS_AUTH; disabled until an admin turns it on.',
    type: ANONYMOUS_CLEANUP_TASK_TYPE,
    schedule: '0 3 * * *',
    enabled: false,
    config: { maxAgeDays: ANONYMOUS_CLEANUP_DEFAULT_MAX_AGE_DAYS },
  });
}
