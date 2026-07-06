/**
 * MetricLineChart — single-series line chart (request rate, error rate).
 *
 * One series → no legend box (the card title names it), 2px line, no dots
 * except on hover, recessive grid/axes. Color is caller-supplied so the
 * error-rate chart can use the reserved error hue while request rate uses
 * chart-1.
 */

import { format } from 'date-fns';
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrafficPoint } from '../../lib/types';
import { ChartTooltip } from './chart-tooltip';

// --- Types -----------------------------------------------------------

export interface MetricLineChartProps {
  points: TrafficPoint[];
  /** Which measure of each point to plot. */
  dataKey: 'total' | 'errors';
  /** Display name for the tooltip row. */
  name: string;
  /** Line color (CSS color; defaults to chart-1). */
  color?: string;
  bucketMinutes: number;
  height?: number;
}

// --- Component -------------------------------------------------------

export function MetricLineChart({
  points,
  dataKey,
  name,
  color = 'var(--chart-1)',
  bucketMinutes,
  height = 200,
}: MetricLineChartProps) {
  const timeFormat = bucketMinutes >= 60 ? 'MMM d HH:mm' : 'HH:mm';
  const data = points.map((p) => ({
    time: format(new Date(p.timestamp), timeFormat),
    [dataKey]: p[dataKey],
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsLineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={{ stroke: 'hsl(var(--border))' }}
          minTickGap={32}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip content={<ChartTooltip />} />
        <Line
          type="monotone"
          dataKey={dataKey}
          name={name}
          stroke={color}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </RechartsLineChart>
    </ResponsiveContainer>
  );
}
MetricLineChart.displayName = 'MetricLineChart';
