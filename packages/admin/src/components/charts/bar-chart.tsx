/**
 * LatencyBarChart — horizontal p50/p95/p99 latency bars.
 *
 * Percentiles are one measure at three points, not three identities, so all
 * bars share a single hue (chart-1) with direct value labels — per the
 * dataviz rules (status colors stay reserved for state, text wears text
 * tokens). Bars are thin with rounded data-ends.
 */

import {
  Bar,
  CartesianGrid,
  Cell,
  LabelList,
  BarChart as RechartsBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SURFACE_SERIES } from './area-chart';
import { ChartTooltip } from './chart-tooltip';

// --- Types -----------------------------------------------------------

export interface LatencyBarChartProps {
  latency: { p50: number; p95: number; p99: number };
  height?: number;
}

const formatMs = (value: number) =>
  value >= 1000 ? `${(value / 1000).toLocaleString()}s` : `${value.toLocaleString()}ms`;

// --- Component -------------------------------------------------------

export function LatencyBarChart({ latency, height = 240 }: LatencyBarChartProps) {
  const data = [
    { name: 'p50', value: latency.p50 },
    { name: 'p95', value: latency.p95 },
    { name: 'p99', value: latency.p99 },
  ];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 48, bottom: 0, left: -8 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={{ stroke: 'hsl(var(--border))' }}
          tickFormatter={formatMs}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={48}
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          content={<ChartTooltip formatValue={formatMs} />}
          cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
        />
        <Bar
          dataKey="value"
          name="Latency"
          fill="var(--chart-1)"
          radius={[0, 4, 4, 0]}
          barSize={16}
          isAnimationActive={false}
        >
          <LabelList
            dataKey="value"
            position="right"
            formatter={(value: unknown) => formatMs(Number(value))}
            style={{ fontSize: 11, fill: 'hsl(var(--foreground))' }}
          />
        </Bar>
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
LatencyBarChart.displayName = 'LatencyBarChart';

// --- Surface breakdown ---------------------------------------------------

export interface SurfaceBarChartProps {
  /** Total requests keyed by surface. */
  bySurface: Record<string, number>;
  height?: number;
}

/**
 * SurfaceBarChart — horizontal bars of request counts per API surface,
 * using the same entity-bound surface colors as the traffic chart.
 */
export function SurfaceBarChart({ bySurface, height = 240 }: SurfaceBarChartProps) {
  const data = SURFACE_SERIES.filter((s) => (bySurface[s.key] ?? 0) > 0).map((s) => ({
    name: s.label,
    value: bySurface[s.key] ?? 0,
    fill: s.color,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 48, bottom: 0, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={{ stroke: 'hsl(var(--border))' }}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={64}
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
        <Bar
          dataKey="value"
          name="Requests"
          radius={[0, 4, 4, 0]}
          barSize={16}
          isAnimationActive={false}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.fill} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(value: unknown) => Number(value).toLocaleString()}
            style={{ fontSize: 11, fill: 'hsl(var(--foreground))' }}
          />
        </Bar>
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
SurfaceBarChart.displayName = 'SurfaceBarChart';
