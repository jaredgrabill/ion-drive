/**
 * useHealth — polls the server's `/health` endpoint and derives a status.
 *
 * Refetches every 30s via TanStack Query. Status mapping:
 *  - `healthy` — endpoint responded `status: "ok"`
 *  - `error`   — request failed or non-ok status
 *  - `idle`    — first fetch still in flight
 *
 * Drives the StatusDot in the sidebar footer and the dashboard banner.
 * (`/health` is proxied by Vite alongside `/api`.)
 */

import { useQuery } from '@tanstack/react-query';
import type { SystemStatus } from '../components/ui';

export interface HealthInfo {
  status: string;
  version: string;
  timestamp: string;
  schemaVersion?: number;
  objectCount?: number;
}

async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch('/health', { credentials: 'include' });
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return (await res.json()) as HealthInfo;
}

export function useHealth(): {
  status: SystemStatus;
  health: HealthInfo | undefined;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
    retry: 1,
    staleTime: 10_000,
  });

  const status: SystemStatus = query.isError
    ? 'error'
    : query.data
      ? query.data.status === 'ok'
        ? 'healthy'
        : 'warning'
      : 'idle';

  return { status, health: query.data, isError: query.isError };
}
