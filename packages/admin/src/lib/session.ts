/** Session state, read from the core `/api/v1/me` endpoint. */

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export function useSession() {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    retry: false,
    staleTime: 30_000,
  });
  const me = query.data;
  return {
    ...query,
    isAuthenticated: me?.authenticated === true,
    roles: me?.roles ?? [],
    isAdmin: (me?.roles ?? []).includes('admin'),
    // First-login claim gate (issue #32): true only for a real session whose
    // bootstrap-created account has not yet completed onboarding.
    pendingClaim: me?.pendingClaim === true,
  };
}
