/**
 * Unit test for the reserved-key guard (issue #32). The DB-touching behavior
 * of `AdminClaimService` (marking, checking, atomically completing/racing a
 * claim) is exercised end-to-end against a real Postgres in
 * integration/admin-claim.integration.test.ts — mirrors the split
 * admin-bootstrap.test.ts uses for the same reason (a raw
 * `pg_advisory_xact_lock` transaction is not meaningfully mockable).
 */

import { describe, expect, it } from 'vitest';
import { PENDING_CLAIM_KEY_PREFIX, isReservedAdminClaimConfigKey } from './admin-claim.js';

describe('isReservedAdminClaimConfigKey', () => {
  it('matches keys under the pending-claim prefix', () => {
    expect(isReservedAdminClaimConfigKey(`${PENDING_CLAIM_KEY_PREFIX}some-user-id`)).toBe(true);
    expect(isReservedAdminClaimConfigKey('admin-claim.pending.')).toBe(true);
  });

  it('does not match unrelated keys, including near-miss prefixes', () => {
    expect(isReservedAdminClaimConfigKey('bootstrap.completed')).toBe(false);
    expect(isReservedAdminClaimConfigKey('admin-claim.pending')).toBe(false); // missing trailing dot
    expect(isReservedAdminClaimConfigKey('some.admin-claim.pending.x')).toBe(false); // not a prefix
    expect(isReservedAdminClaimConfigKey('')).toBe(false);
  });
});
