/**
 * Dashboard — live operational overview ("system pulse").
 *
 * Top to bottom: a system-status banner (health + uptime), four stat cards
 * (objects / users / 24h requests / tasks — each links to its page), a
 * charts row (stacked traffic by surface + latency percentiles), recent
 * errors + recent objects, and an installed-blocks row when any exist.
 * Data comes from `GET /api/v1/stats*`, `/version`, and the existing
 * object queries; everything renders skeletons while loading.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity,
  Blocks as BlocksIcon,
  CalendarClock,
  Database,
  Users as UsersIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { LatencyBarChart, TrafficAreaChart } from '../components/charts';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  StatusDot,
} from '../components/ui';
import { useHealth } from '../hooks';
import { api } from '../lib/api';

// --- Small pieces ------------------------------------------------------

function StatCard({
  label,
  value,
  to,
  icon: Icon,
  loading,
}: {
  label: string;
  value: number | string;
  to: string;
  icon: typeof Database;
  loading: boolean;
}) {
  return (
    <Link to={to}>
      <Card className="transition-colors hover:border-ring">
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            {loading ? (
              <Skeleton className="mt-1 h-8 w-16" />
            ) : (
              <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
            )}
          </div>
          <Icon className="h-8 w-8 text-muted-foreground/40" aria-hidden />
        </CardContent>
      </Card>
    </Link>
  );
}
StatCard.displayName = 'StatCard';

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="p-3">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-3">{children}</CardContent>
    </Card>
  );
}
ChartCard.displayName = 'ChartCard';

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

// --- Page --------------------------------------------------------------

export function Dashboard() {
  const { status } = useHealth();
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.stats(),
    refetchInterval: 30_000,
  });
  const traffic = useQuery({
    queryKey: ['traffic', '24h'],
    queryFn: () => api.traffic('24h'),
    refetchInterval: 60_000,
  });
  const errors = useQuery({
    queryKey: ['recent-errors'],
    queryFn: () => api.recentErrors(5),
    refetchInterval: 30_000,
  });
  const version = useQuery({ queryKey: ['version'], queryFn: () => api.version() });
  const objects = useQuery({ queryKey: ['objects'], queryFn: () => api.listObjects() });
  const blocks = useQuery({ queryKey: ['blocks'], queryFn: () => api.listBlocks(), retry: false });

  const userObjects = (objects.data ?? []).filter((o) => !o.isSystem);
  const healthy = status === 'healthy';

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      {/* System status banner */}
      <Card
        className={
          status === 'error'
            ? 'bg-gradient-to-r from-ion-red/5 to-transparent'
            : 'bg-gradient-to-r from-ion-green/5 to-transparent'
        }
      >
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          <StatusDot
            status={status}
            pulse={healthy}
            label={healthy ? 'All systems operational' : 'System issue detected'}
          />
          <p className="font-medium">
            {status === 'error'
              ? 'System unreachable'
              : status === 'idle'
                ? 'Checking system status…'
                : 'All Systems Operational'}
          </p>
          {version.data && (
            <p className="ml-auto text-sm text-muted-foreground">
              v{version.data.version} · up {formatUptime(version.data.uptimeSeconds)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Data Objects"
          value={stats.data?.objects ?? 0}
          to="/objects"
          icon={Database}
          loading={stats.isLoading}
        />
        <StatCard
          label="Users"
          value={stats.data?.users ?? 0}
          to="/users"
          icon={UsersIcon}
          loading={stats.isLoading}
        />
        <StatCard
          label="API Requests (24h)"
          value={(stats.data?.requests24h ?? 0).toLocaleString()}
          to="/metrics"
          icon={Activity}
          loading={stats.isLoading}
        />
        <StatCard
          label="Scheduled Tasks"
          value={stats.data?.tasks ?? 0}
          to="/tasks"
          icon={CalendarClock}
          loading={stats.isLoading}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ChartCard title="API Traffic (24h)">
            {traffic.isLoading ? (
              <Skeleton className="h-[240px] w-full" />
            ) : (traffic.data?.totals.requests ?? 0) === 0 ? (
              <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
                No traffic recorded yet.
              </div>
            ) : (
              traffic.data && (
                <TrafficAreaChart
                  points={traffic.data.points}
                  bucketMinutes={traffic.data.bucketMinutes}
                />
              )
            )}
          </ChartCard>
        </div>
        <div className="lg:col-span-2">
          <ChartCard title="Response Times (24h)">
            {traffic.isLoading ? (
              <Skeleton className="h-[240px] w-full" />
            ) : (
              traffic.data && <LatencyBarChart latency={traffic.data.latency} />
            )}
          </ChartCard>
        </div>
      </div>

      {/* Recent errors + recent objects */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between p-3">
            <CardTitle className="text-sm">Recent Errors</CardTitle>
            <Link to="/logs" className="text-xs text-muted-foreground hover:text-foreground">
              View all logs →
            </Link>
          </CardHeader>
          <CardContent className="p-3">
            {(errors.data ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No recent errors 🎉</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border/60">
                {(errors.data ?? []).map((err) => (
                  <li
                    key={`${err.timestamp}-${err.path}`}
                    className="flex items-center gap-2 py-1.5 text-sm"
                  >
                    <Badge variant={err.status >= 500 ? 'destructive' : 'warning'}>
                      {err.status}
                    </Badge>
                    <span className="font-mono text-xs">{err.method}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {err.path}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(err.timestamp), { addSuffix: true })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between p-3">
            <CardTitle className="text-sm">Recent Objects</CardTitle>
            <Link to="/objects" className="text-xs text-muted-foreground hover:text-foreground">
              View all →
            </Link>
          </CardHeader>
          <CardContent className="p-3">
            {userObjects.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No data objects yet.{' '}
                <Link to="/objects" className="underline">
                  Create one
                </Link>
                .
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border/60">
                {userObjects.slice(0, 6).map((o) => (
                  <li key={o.name} className="flex items-center justify-between py-1.5 text-sm">
                    <Link
                      to="/objects/$name"
                      params={{ name: o.name }}
                      className="font-medium hover:underline"
                    >
                      {o.displayName}
                    </Link>
                    <span className="text-xs text-muted-foreground">{o.fieldCount} fields</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Installed blocks */}
      {(blocks.data ?? []).length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between p-3">
            <CardTitle className="text-sm">Building Blocks</CardTitle>
            <Link to="/blocks" className="text-xs text-muted-foreground hover:text-foreground">
              Manage blocks →
            </Link>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
            {(blocks.data ?? []).map((block) => (
              <div
                key={block.name}
                className="flex items-center gap-3 rounded-md border border-border p-3"
              >
                <BlocksIcon className="h-5 w-5 text-ion-purple" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{block.title}</p>
                  <p className="text-xs text-muted-foreground">
                    v{block.version} · {block.createdObjects.length} objects
                  </p>
                </div>
                <Badge
                  variant={block.status === 'installed' ? 'success' : 'warning'}
                  className="ml-auto"
                >
                  {block.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
Dashboard.displayName = 'Dashboard';
