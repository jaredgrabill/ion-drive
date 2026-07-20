/**
 * Admin claim service (issue #32) — the first-login "claim" flow that follows
 * env-var admin bootstrap (issue #26).
 *
 * **Storage.** The "pending claim" marker is a `_ion_config` row keyed to the
 * bootstrapped user's id (`admin-claim.pending.<userId>`) — a durable,
 * service-only location, not a column on the `user` table and not reachable
 * through the dynamic data API: `/api/v1/data/:object` only ever addresses
 * objects registered in `_ion_objects` (see ADR-009), and neither Better
 * Auth's tables nor `_ion_config` are ever registered there, so no REST,
 * GraphQL, or MCP data-plane request can name this key. The generic admin
 * `PUT/DELETE /api/v1/config/:key` route additionally refuses to touch keys
 * under the reserved prefix (see {@link isReservedAdminClaimConfigKey}), so
 * even a caller holding `manage:config` cannot forge or clear a claim through
 * that surface — only this module's own methods ever write the key.
 *
 * **Security model** (mirrors issue #32's non-negotiable invariants):
 *  - {@link AdminClaimService.markPendingClaim} is called from exactly one
 *    call site: `bootstrapAdminFromEnv`, immediately after it creates the
 *    account — never from an HTTP handler, so no request can set it.
 *  - {@link AdminClaimService.completeClaim} takes the target user id as a
 *    plain argument; every caller (see api/admin-claim-routes.ts) MUST derive
 *    it from the requester's own authenticated session (`request.auth.userId`)
 *    — never from a request body — so the claim can only ever land on the
 *    caller's own account.
 *  - The check-then-clear is race-proof: a Postgres advisory lock scoped to
 *    the target user id serializes concurrent claims for the same account,
 *    and the marker row is deleted (in the same transaction) only *after* the
 *    password/name rotation succeeds — so a losing concurrent request, or one
 *    whose new password fails Better Auth's own policy, observes the marker
 *    untouched (retryable / a clean "already claimed"), never a torn claim
 *    where the marker is gone but the password was never rotated.
 */

import { type Kysely, sql } from 'kysely';
import type { SystemDatabase } from '../db/types.js';

/** `_ion_config` key prefix reserved for admin-claim pending markers. */
export const PENDING_CLAIM_KEY_PREFIX = 'admin-claim.pending.';

/**
 * True for `_ion_config` keys the admin-claim flow owns exclusively. Used by
 * the generic admin config routes to refuse direct read/write of this
 * namespace — defense in depth on top of the marker never being reachable
 * through the public data plane at all.
 */
export function isReservedAdminClaimConfigKey(key: string): boolean {
  return key.startsWith(PENDING_CLAIM_KEY_PREFIX);
}

function pendingClaimKey(userId: string): string {
  return `${PENDING_CLAIM_KEY_PREFIX}${userId}`;
}

/**
 * Raised by {@link AdminClaimService.completeClaim} when the caller's session
 * does not correspond to an account with a live pending-claim marker —
 * already claimed, a replay, an account that was never bootstrapped, or the
 * loser of a concurrent race. Maps to HTTP 409 at the route layer.
 */
export class AdminClaimNotPendingError extends Error {
  readonly statusCode = 409;

  constructor(message = 'This account has no pending claim to complete') {
    super(message);
    this.name = 'AdminClaimNotPendingError';
  }
}

/**
 * The slice of `BetterAuthProvider` the claim flow needs (eases testing,
 * mirrors the `AdminBootstrapAuthProvider` narrow-interface pattern in
 * admin-bootstrap.ts).
 */
export interface AdminClaimAuthProvider {
  completeAdminClaim(input: { userId: string; name: string; newPassword: string }): Promise<void>;
}

export interface AdminClaimServiceDeps {
  /** System DB handle — `_ion_config` lives there. */
  systemDb: Kysely<SystemDatabase>;
  authProvider: AdminClaimAuthProvider;
}

/**
 * Stable-but-arbitrary advisory lock namespace for claim completion — the
 * ASCII of "IONC", deliberately distinct from the first-admin-grant lock in
 * role-manager.ts (`IONA`) so the two never contend. Combined with
 * `hashtext()` of the target user id (Postgres's two-key
 * `pg_advisory_xact_lock` form) so claims for different accounts never
 * serialize against each other — a future-proofing concern, since today there
 * is at most one pending-claim account at a time.
 */
const CLAIM_LOCK_NAMESPACE = 0x494f_4e43; // 1_229_870_659

export class AdminClaimService {
  constructor(private readonly deps: AdminClaimServiceDeps) {}

  /**
   * Marks `userId` pending-claim. Called ONLY by the env bootstrap right
   * after it creates the account — this is not, and must never become,
   * reachable from an HTTP request (issue #32 invariant 2).
   */
  async markPendingClaim(userId: string): Promise<void> {
    await this.deps.systemDb
      .insertInto('_ion_config')
      .values({
        key: pendingClaimKey(userId),
        value: JSON.stringify(true),
        description:
          'Admin bootstrap claim pending (issue #32) — cleared atomically once the account completes first-login onboarding.',
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
  }

  /** Whether `userId` currently has a live pending-claim marker. */
  async isPendingClaim(userId: string): Promise<boolean> {
    const row = await this.deps.systemDb
      .selectFrom('_ion_config')
      .select('key')
      .where('key', '=', pendingClaimKey(userId))
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Completes the claim for `userId` — callers MUST have derived this id from
   * the requester's own authenticated session, never a request body (issue
   * #32 invariant 4). Sets the display name, rotates the password via the
   * auth provider, and clears the marker atomically (invariant 2).
   *
   * Throws {@link AdminClaimNotPendingError} (409) when there is no live
   * marker for this user — already claimed, replayed, or the loser of a
   * concurrent race (invariant 7) — and propagates the auth provider's own
   * password-policy error (400) when `newPassword` is rejected, leaving the
   * marker untouched either way so a legitimate retry can still succeed.
   */
  async completeClaim(input: { userId: string; name: string; newPassword: string }): Promise<void> {
    const { systemDb, authProvider } = this.deps;
    const key = pendingClaimKey(input.userId);

    await systemDb.transaction().execute(async (trx) => {
      // Serializes concurrent claim attempts for the same user id: the loser
      // blocks here until the winner's transaction commits or rolls back,
      // then re-runs the marker check itself and (correctly) finds nothing.
      await sql`SELECT pg_advisory_xact_lock(${CLAIM_LOCK_NAMESPACE}, hashtext(${input.userId}))`.execute(
        trx,
      );

      const marker = await trx
        .selectFrom('_ion_config')
        .select('key')
        .where('key', '=', key)
        .executeTakeFirst();
      if (!marker) throw new AdminClaimNotPendingError();

      // Rotate password + name BEFORE clearing the marker: if the auth
      // provider rejects the new password, this throws, the transaction
      // rolls back (the marker row is untouched), and the caller can retry —
      // the account can never end up "claimed" without the password having
      // actually been rotated off the bootstrap value.
      await authProvider.completeAdminClaim({
        userId: input.userId,
        name: input.name,
        newPassword: input.newPassword,
      });

      await trx.deleteFrom('_ion_config').where('key', '=', key).execute();
    });
  }
}
