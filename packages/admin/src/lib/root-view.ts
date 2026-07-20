/**
 * Pure decision for what the app root renders (issue #32's onboarding gate).
 *
 * Kept dependency-free (no React, no router) so the security-relevant part of
 * the claim gate — every route renders Onboarding, never the app shell, until
 * a pending-claim account completes onboarding — is unit-testable without
 * mounting the router-dependent app shell tree.
 */

export type RootView = 'loading' | 'login' | 'onboarding' | 'app';

export function resolveRootView(session: {
  isLoading: boolean;
  isAuthenticated: boolean;
  pendingClaim: boolean;
}): RootView {
  if (session.isLoading) return 'loading';
  if (!session.isAuthenticated) return 'login';
  if (session.pendingClaim) return 'onboarding';
  return 'app';
}
