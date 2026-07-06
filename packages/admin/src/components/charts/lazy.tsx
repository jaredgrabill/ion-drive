/**
 * Lazy chart wrappers — code-split recharts out of the initial bundle.
 *
 * recharts (+ its d3 dependencies) is by far the heaviest dependency in the
 * console. These wrappers `React.lazy` each chart and render a same-size
 * Skeleton while the chunk loads, so the Dashboard/Metrics pages keep the
 * <200KB initial-bundle budget with zero layout shift. Pages import from
 * here; only tests and this file import the chart modules directly.
 */

import { Suspense, lazy } from 'react';
import { Skeleton } from '../ui';
import type { TrafficAreaChartProps } from './area-chart';
import type { LatencyBarChartProps, SurfaceBarChartProps } from './bar-chart';
import type { MetricLineChartProps } from './line-chart';

const AreaChartInner = lazy(() =>
  import('./area-chart').then((m) => ({ default: m.TrafficAreaChart })),
);
const LatencyInner = lazy(() =>
  import('./bar-chart').then((m) => ({ default: m.LatencyBarChart })),
);
const SurfaceInner = lazy(() =>
  import('./bar-chart').then((m) => ({ default: m.SurfaceBarChart })),
);
const LineInner = lazy(() => import('./line-chart').then((m) => ({ default: m.MetricLineChart })));

function fallback(height: number) {
  return <Skeleton style={{ height }} className="w-full" aria-hidden />;
}

export function TrafficAreaChart(props: TrafficAreaChartProps) {
  return (
    <Suspense fallback={fallback(props.height ?? 240)}>
      <AreaChartInner {...props} />
    </Suspense>
  );
}
TrafficAreaChart.displayName = 'TrafficAreaChart';

export function LatencyBarChart(props: LatencyBarChartProps) {
  return (
    <Suspense fallback={fallback(props.height ?? 240)}>
      <LatencyInner {...props} />
    </Suspense>
  );
}
LatencyBarChart.displayName = 'LatencyBarChart';

export function SurfaceBarChart(props: SurfaceBarChartProps) {
  return (
    <Suspense fallback={fallback(props.height ?? 240)}>
      <SurfaceInner {...props} />
    </Suspense>
  );
}
SurfaceBarChart.displayName = 'SurfaceBarChart';

export function MetricLineChart(props: MetricLineChartProps) {
  return (
    <Suspense fallback={fallback(props.height ?? 200)}>
      <LineInner {...props} />
    </Suspense>
  );
}
MetricLineChart.displayName = 'MetricLineChart';
