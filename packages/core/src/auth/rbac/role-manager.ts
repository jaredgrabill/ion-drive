/**
 * Role Manager — CRUD for roles and user↔role assignments.
 *
 * Roles live in `_ion_roles` with an embedded permission set (JSONB); assignments
 * live in `_ion_user_roles`. On first run, {@link seedDefaults} creates the
 * built-in admin/editor/viewer/public roles.
 *
 * The built-in `public` role (issue #8) is fenced here so every caller —
 * REST admin routes, block installers, embedders — inherits the rails:
 * read-only grants on named objects, no rename, no user assignment
 * (deletion is already blocked for all system roles). Violations throw
 * {@link RoleValidationError} (HTTP 400 at the route layer).
 */

import { type Kysely, sql } from 'kysely';
import type { IonRole, PermissionGrant, SystemDatabase } from '../../db/types.js';
import {
  ANONYMOUS_ROLE_NAME,
  DEFAULT_ROLES,
  PUBLIC_ROLE_NAME,
  validatePublicRoleGrants,
} from './policy-types.js';

/** A role mutation violated a validation rail (maps to HTTP 400). */
export class RoleValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'RoleValidationError';
  }
}

export interface RoleInput {
  name: string;
  description?: string | null;
  permissions: PermissionGrant[];
}

/**
 * Stable key for the transaction-scoped advisory lock that serializes the
 * first-boot admin bootstrap ({@link RoleManager.grantAdminIfFirstUser}).
 * Arbitrary but fixed — the ASCII of "IONA" — so every instance contends on
 * the same lock across the cluster.
 */
const BOOTSTRAP_ADMIN_LOCK_KEY = 0x494f_4e41; // 1_229_870_657

/**
 * `_ion_config` key for the durable "the first-admin bootstrap has completed"
 * marker (audit V4). Once set it is never cleared, so removing every role
 * assignment cannot re-open public signup or re-grant admin to the next
 * sign-up. The live assignment count only gates the very first boot.
 */
const BOOTSTRAP_COMPLETE_KEY = 'bootstrap.completed';

export class RoleManager {
  constructor(private readonly db: Kysely<SystemDatabase>) {}

  /** Creates the built-in roles if they don't already exist. Idempotent. */
  async seedDefaults(): Promise<void> {
    for (const role of DEFAULT_ROLES) {
      await this.db
        .insertInto('_ion_roles')
        .values({
          name: role.name,
          description: role.description,
          permissions: JSON.stringify(role.permissions),
          is_system: true,
        })
        .onConflict((oc) => oc.column('name').doNothing())
        .execute();
    }
  }

  async list(): Promise<IonRole[]> {
    return this.db.selectFrom('_ion_roles').selectAll().orderBy('name').execute();
  }

  async getById(id: string): Promise<IonRole | undefined> {
    return this.db.selectFrom('_ion_roles').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async getByName(name: string): Promise<IonRole | undefined> {
    return this.db.selectFrom('_ion_roles').selectAll().where('name', '=', name).executeTakeFirst();
  }

  async create(input: RoleInput): Promise<IonRole> {
    if (input.name === PUBLIC_ROLE_NAME) {
      throw new RoleValidationError(
        `"${PUBLIC_ROLE_NAME}" is a reserved built-in role — edit its grants instead of creating it`,
      );
    }
    return this.db
      .insertInto('_ion_roles')
      .values({
        name: input.name,
        description: input.description ?? null,
        permissions: JSON.stringify(input.permissions),
        is_system: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, input: Partial<RoleInput>): Promise<IonRole | undefined> {
    const existing = await this.getById(id);
    if (existing) this.assertUpdateAllowed(existing, input);

    const patch: Record<string, unknown> = { updated_at: sql`now()` };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.permissions !== undefined) patch.permissions = JSON.stringify(input.permissions);

    return this.db
      .updateTable('_ion_roles')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * The public-role rails, applied on every update path (issue #8):
   * the role cannot be renamed, its grants must stay read-only on named data
   * objects, and no other role may take its reserved name.
   */
  private assertUpdateAllowed(existing: IonRole, input: Partial<RoleInput>): void {
    if (existing.name !== PUBLIC_ROLE_NAME) {
      if (input.name === PUBLIC_ROLE_NAME) {
        throw new RoleValidationError(`"${PUBLIC_ROLE_NAME}" is a reserved built-in role name`);
      }
      return;
    }
    if (input.name !== undefined && input.name !== PUBLIC_ROLE_NAME) {
      throw new RoleValidationError('The public role cannot be renamed');
    }
    if (input.permissions !== undefined) {
      const violation = validatePublicRoleGrants(input.permissions);
      if (violation) throw new RoleValidationError(violation);
    }
  }

  /** Deletes a non-system role. Returns false if missing or system-managed. */
  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('_ion_roles')
      .where('id', '=', id)
      .where('is_system', '=', false)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  // --- Assignments ---

  async assign(userId: string, roleId: string): Promise<void> {
    const role = await this.getById(roleId);
    if (role?.name === PUBLIC_ROLE_NAME) {
      throw new RoleValidationError(
        'The public role represents anonymous requests and cannot be assigned to users',
      );
    }
    await this.db
      .insertInto('_ion_user_roles')
      .values({ user_id: userId, role_id: roleId })
      .onConflict((oc) => oc.columns(['user_id', 'role_id']).doNothing())
      .execute();
  }

  async unassign(userId: string, roleId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('_ion_user_roles')
      .where('user_id', '=', userId)
      .where('role_id', '=', roleId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /** Returns the roles assigned to a user. */
  async getRolesForUser(userId: string): Promise<IonRole[]> {
    return this.db
      .selectFrom('_ion_user_roles')
      .innerJoin('_ion_roles', '_ion_roles.id', '_ion_user_roles.role_id')
      .selectAll('_ion_roles')
      .where('_ion_user_roles.user_id', '=', userId)
      .execute();
  }

  /**
   * First-boot bootstrap grant: assigns the admin role to `userId` **iff no
   * role assignment exists yet**, and reports whether it did. Guarantees at
   * most one bootstrap admin even under concurrent sign-ups (audit V3) —
   * without this, two sign-ups racing in the first-boot window both observe an
   * empty `_ion_user_roles` and both become admin.
   *
   * The check-and-grant runs inside a single transaction serialized by a
   * transaction-scoped Postgres advisory lock: the first attempt holds the
   * lock through commit; every concurrent attempt blocks on it, then observes
   * the now-non-empty table and returns false.
   */
  async grantAdminIfFirstUser(userId: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADMIN_LOCK_KEY})`.execute(trx);

      // Durable gate: once bootstrap has ever completed, never grant again —
      // even if every assignment was later removed (audit V4).
      const marker = await trx
        .selectFrom('_ion_config')
        .select('key')
        .where('key', '=', BOOTSTRAP_COMPLETE_KEY)
        .executeTakeFirst();
      if (marker) return false;

      // No marker yet. If assignments already exist (a pre-marker deployment),
      // record the marker but do NOT grant a second admin. Anonymous-role
      // assignments are excluded: guests minted before the first real sign-up
      // (ION_ANONYMOUS_AUTH) must not close the bootstrap window.
      if ((await this.countBootstrapAssignments(trx)) > 0) {
        await this.writeBootstrapMarker(trx);
        return false;
      }

      const admin = await trx
        .selectFrom('_ion_roles')
        .selectAll()
        .where('name', '=', 'admin')
        .executeTakeFirst();
      if (!admin) return false;
      await trx
        .insertInto('_ion_user_roles')
        .values({ user_id: userId, role_id: admin.id })
        .onConflict((oc) => oc.columns(['user_id', 'role_id']).doNothing())
        .execute();
      // Close the bootstrap window atomically with the grant.
      await this.writeBootstrapMarker(trx);
      return true;
    });
  }

  /**
   * Whether the first-admin bootstrap has completed (audit V4). True when the
   * durable marker is set; falls back to "any assignment exists" for
   * deployments predating the marker (which {@link ensureBootstrapMarker}
   * backfills at boot). Used by the signup lockout so it never re-opens.
   */
  async isBootstrapComplete(): Promise<boolean> {
    const marker = await this.db
      .selectFrom('_ion_config')
      .select('key')
      .where('key', '=', BOOTSTRAP_COMPLETE_KEY)
      .executeTakeFirst();
    if (marker) return true;
    return (await this.countBootstrapAssignments(this.db)) > 0;
  }

  /**
   * Backfills the durable bootstrap marker at boot for deployments that already
   * have role assignments but predate the marker — so the signup lockout is
   * durable for them from the next boot onward. No-op once the marker exists.
   */
  async ensureBootstrapMarker(): Promise<void> {
    const marker = await this.db
      .selectFrom('_ion_config')
      .select('key')
      .where('key', '=', BOOTSTRAP_COMPLETE_KEY)
      .executeTakeFirst();
    if (marker) return;
    if ((await this.countBootstrapAssignments(this.db)) > 0) {
      await this.writeBootstrapMarker(this.db);
    }
  }

  /**
   * Number of role assignments that count toward first-admin bootstrap — i.e.
   * everything except assignments of the built-in `anonymous` role. Guests
   * minted by anonymous sign-in receive that role automatically, and treating
   * those grants as "an admin exists" would permanently lock a fresh server
   * out of its first admin (and, with ION_DISABLE_SIGNUP, out of signup).
   */
  private async countBootstrapAssignments(db: Kysely<SystemDatabase>): Promise<number> {
    const row = await db
      .selectFrom('_ion_user_roles')
      .innerJoin('_ion_roles', '_ion_roles.id', '_ion_user_roles.role_id')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('_ion_roles.name', '!=', ANONYMOUS_ROLE_NAME)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** Writes the durable bootstrap-complete marker (idempotent). */
  private async writeBootstrapMarker(db: Kysely<SystemDatabase>): Promise<void> {
    await db
      .insertInto('_ion_config')
      .values({
        key: BOOTSTRAP_COMPLETE_KEY,
        value: JSON.stringify(true),
        description: 'First-admin bootstrap has completed; public signup stays closed.',
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
  }

  /** Total number of user↔role assignments (used to detect first-run). */
  async assignmentCount(): Promise<number> {
    const row = await this.db
      .selectFrom('_ion_user_roles')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** Returns the user IDs assigned a given role. */
  async getUsersForRole(roleId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('_ion_user_roles')
      .select('user_id')
      .where('role_id', '=', roleId)
      .execute();
    return rows.map((r) => r.user_id);
  }
}
