/**
 * Role Manager — CRUD for roles and user↔role assignments.
 *
 * Roles live in `_ion_roles` with an embedded permission set (JSONB); assignments
 * live in `_ion_user_roles`. On first run, {@link seedDefaults} creates the
 * built-in admin/editor/viewer roles.
 */

import { type Kysely, sql } from 'kysely';
import type { IonRole, PermissionGrant, SystemDatabase } from '../../db/types.js';
import { DEFAULT_ROLES } from './policy-types.js';

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
      const countRow = await trx
        .selectFrom('_ion_user_roles')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst();
      if (Number(countRow?.count ?? 0) > 0) return false;
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
      return true;
    });
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
