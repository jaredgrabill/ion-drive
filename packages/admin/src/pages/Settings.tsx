/**
 * Settings — instance information and feature flags.
 *
 * API keys moved to their own page in Phase 8; Settings now shows the
 * server version/uptime/runtime from `GET /api/v1/version` and which
 * feature surfaces are enabled (auth enforcement, tasks, blocks, events,
 * metrics, OTel). Flags are env-driven, so they render read-only with the
 * controlling variable named.
 */

import { useQuery } from '@tanstack/react-query';
import { SchemaHealthCard } from '../components/schema';
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from '../components/ui';
import { api } from '../lib/api';

const FLAG_LABELS: { key: keyof FeatureFlags; label: string; env: string }[] = [
  { key: 'auth', label: 'RBAC enforcement', env: 'ION_REQUIRE_AUTH' },
  { key: 'tasks', label: 'Task scheduler', env: 'ION_TASKS_ENABLED' },
  { key: 'blocks', label: 'Building blocks', env: 'ION_BLOCKS_ENABLED' },
  { key: 'events', label: 'Message bus / events', env: 'ION_EVENTS_ENABLED' },
  { key: 'metrics', label: 'Prometheus /metrics', env: 'ION_METRICS_ENABLED' },
  { key: 'otel', label: 'OpenTelemetry export', env: 'ION_OTEL_ENABLED' },
];

interface FeatureFlags {
  auth: boolean;
  tasks: boolean;
  blocks: boolean;
  events: boolean;
  metrics: boolean;
  otel: boolean;
}

/** Formats process uptime as "3d 4h" / "2h 5m" / "42s". */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export function SettingsPage() {
  const version = useQuery({ queryKey: ['version'], queryFn: () => api.version() });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      <SchemaHealthCard />

      <Card>
        <CardHeader>
          <CardTitle>Instance</CardTitle>
        </CardHeader>
        <CardContent>
          {version.isLoading ? (
            <Skeleton className="h-16 w-full" aria-hidden />
          ) : version.data ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Version</dt>
                <dd className="mt-0.5 font-mono">v{version.data.version}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Uptime</dt>
                <dd className="mt-0.5">{formatUptime(version.data.uptimeSeconds)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Node</dt>
                <dd className="mt-0.5 font-mono">{version.data.nodeVersion}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Could not load version info.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Feature flags</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <tbody>
              {FLAG_LABELS.map((flag) => {
                const enabled = version.data?.features[flag.key];
                return (
                  <tr key={flag.key} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2.5 font-medium">{flag.label}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {flag.env}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {version.isLoading ? (
                        <Skeleton className="ml-auto h-5 w-14" aria-hidden />
                      ) : (
                        <Badge variant={enabled ? 'success' : 'secondary'}>
                          {enabled ? 'enabled' : 'disabled'}
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Feature flags are environment-driven — set the variable and restart the server to change
        them. API keys now live under{' '}
        <a href="/api-keys" className="underline">
          Access → API Keys
        </a>
        .
      </p>
    </div>
  );
}
SettingsPage.displayName = 'SettingsPage';
