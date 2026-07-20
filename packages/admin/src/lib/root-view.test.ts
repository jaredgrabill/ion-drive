/**
 * Tests for the admin claim gate's routing decision (issue #32). This is the
 * client-side half of "it must be impossible to reach other admin surfaces
 * first": `RootGate` (router.tsx) renders exactly what this function returns
 * for the ENTIRE route tree, so `pendingClaim: true` must never resolve to
 * `'app'` no matter what else is true of the session.
 */

import { describe, expect, it } from 'vitest';
import { resolveRootView } from './root-view';

describe('resolveRootView', () => {
  it('shows the loading state first, regardless of auth/claim state', () => {
    expect(resolveRootView({ isLoading: true, isAuthenticated: false, pendingClaim: false })).toBe(
      'loading',
    );
    expect(resolveRootView({ isLoading: true, isAuthenticated: true, pendingClaim: true })).toBe(
      'loading',
    );
  });

  it('shows Login when not authenticated', () => {
    expect(resolveRootView({ isLoading: false, isAuthenticated: false, pendingClaim: false })).toBe(
      'login',
    );
    // Even a (nonsensical) pendingClaim:true with no auth still can't reach
    // the app shell — Login wins over onboarding when unauthenticated.
    expect(resolveRootView({ isLoading: false, isAuthenticated: false, pendingClaim: true })).toBe(
      'login',
    );
  });

  it('shows Onboarding — never the app shell — for an authenticated pending-claim session', () => {
    expect(resolveRootView({ isLoading: false, isAuthenticated: true, pendingClaim: true })).toBe(
      'onboarding',
    );
  });

  it('shows the app shell only once authenticated and claimed', () => {
    expect(resolveRootView({ isLoading: false, isAuthenticated: true, pendingClaim: false })).toBe(
      'app',
    );
  });
});
