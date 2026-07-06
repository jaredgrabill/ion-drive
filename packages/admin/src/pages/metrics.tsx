/**
 * Metrics — lightweight operational chart dashboard.
 *
 * A 2×2 grid over `GET /api/v1/stats/traffic`: request rate (line),
 * error rate (line, reserved error hue), latency percentiles (bars), and
 * request breakdown by surface (entity-colored bars). A 1h/6h/24h/7d
 * period selector (Tabs) drives all four. For deep dives, `/metrics`
 * (Prometheus) remains the scrape surface.
 */

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  LatencyBarChart,
  MetricLineChart,
  SurfaceBarChart,
  TrafficAreaChart,
} from '../components/charts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '../components/ui';
import { api } from '../lib/api';
import type { TrafficPeriod } from '../lib/types';

const PERIODS: TrafficPeriod[] = ['1h', '6h', '24h', '7d'];

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

/** Sums each surface's request counts across all traffic points. */
function sumBySurface(points: { bySurface: Record<string, number> }[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const point of points) {
    for (const [surface, count] of Object.entries(point.bySurface)) {
      totals[surface] = (totals[surface] ?? 0) + count;
    }
  }
  return totals;
}

export function Metrics() {
  const [period, setPeriod] = useState<TrafficPeriod>('24h');
  const traffic = useQuery({
    queryKey: ['traffic', period],
    queryFn: () => api.traffic(period),
    refetchInterval: 60_000,
  });

  const summary = traffic.data;
  const totalBySurface = sumBySurface(summary?.points ?? []);
  const empty = (summary?.totals.requests ?? 0) === 0;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Metrics</h1>
          <p className="text-sm text-muted-foreground">
            In-process API traffic. Scrape <code className="font-mono">/metrics</code> with
            Prometheus for durable history.
          </p>
        </div>
        <Tabs value={period} onValueChange={(v) => setPeriod(v as TrafficPeriod)}>
          <TabsList className="border-none">
            {PERIODS.map((p) => (
              <TabsTrigger key={p} value={p} className="px-3 py-1.5">
                {p}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {traffic.isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-hidden>
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      ) : (
        <ChartsGrid summary={summary} totalBySurface={totalBySurface} empty={empty} />
      )}

      {!traffic.isLoading && !empty && summary && (
        <div className="mt-4">
          <ChartCard title={`Traffic by surface (${period})`}>
            <TrafficAreaChart points={summary.points} bucketMinutes={summary.bucketMinutes} />
          </ChartCard>
        </div>
      )}
    </div>
  );
}
Metrics.displayName = 'Metrics';

/** The 2×2 chart grid: request rate, error rate, latency, and surface mix. */
function ChartsGrid({
  summary,
  totalBySurface,
  empty,
}: {
  summary: Awaited<ReturnType<typeof api.traffic>> | undefined;
  totalBySurface: Record<string, number>;
  empty: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ChartCard title="Request rate">
        {empty ? (
          <EmptyChart />
        ) : (
          summary && (
            <MetricLineChart
              points={summary.points}
              dataKey="total"
              name="Requests"
              bucketMinutes={summary.bucketMinutes}
            />
          )
        )}
      </ChartCard>
      <ChartCard title="Error rate">
        {empty ? (
          <EmptyChart />
        ) : (
          summary && (
            <MetricLineChart
              points={summary.points}
              dataKey="errors"
              name="Errors"
              color="hsl(var(--ion-red))"
              bucketMinutes={summary.bucketMinutes}
            />
          )
        )}
      </ChartCard>
      <ChartCard title="Latency percentiles">
        {empty ? (
          <EmptyChart />
        ) : (
          summary && <LatencyBarChart latency={summary.latency} height={200} />
        )}
      </ChartCard>
      <ChartCard title="Requests by surface">
        {empty ? <EmptyChart /> : <SurfaceBarChart bySurface={totalBySurface} height={200} />}
      </ChartCard>
    </div>
  );
}
ChartsGrid.displayName = 'ChartsGrid';

function EmptyChart() {
  return (
    <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
      No traffic in this period.
    </div>
  );
}
EmptyChart.displayName = 'EmptyChart';
