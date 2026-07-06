/**
 * TrafficAreaChart — stacked area chart of API traffic by surface.
 *
 * A thin recharts wrapper with Ion Drive styling. Series colors come from
 * the validated `--chart-*` palette and are bound to the *surface* (rest →
 * chart-1, mcp → chart-2, graphql → chart-3, …), never to rank, so a
 * filtered view never repaints survivors. Stacked fills get a 1.5px
 * surface-colored stroke as the spacer between bands. A legend always
 * renders (≥2 series); the grid/axes are recessive.
 */

import { format } from 'date-fns';
import {
  Area,
  CartesianGrid,
  Legend,
  AreaChart as RechartsAreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrafficPoint } from '../../lib/types';
import { ChartTooltip } from './chart-tooltip';

// --- Series definition (fixed order + entity-bound colors) --------------

export const SURFACE_SERIES = [
  { key: 'rest', label: 'REST', color: 'var(--chart-1)' },
  { key: 'mcp', label: 'MCP', color: 'var(--chart-2)' },
  { key: 'graphql', label: 'GraphQL', color: 'var(--chart-3)' },
  { key: 'admin', label: 'Admin', color: 'var(--chart-4)' },
  { key: 'other', label: 'Other', color: 'var(--chart-5)' },
] as const;

export interface TrafficAreaChartProps {
  points: TrafficPoint[];
  /** Minutes per bucket — drives the time-axis label format. */
  bucketMinutes: number;
  height?: number;
}

// --- Component -------------------------------------------------------

export function TrafficAreaChart({ points, bucketMinutes, height = 240 }: TrafficAreaChartProps) {
  const timeFormat = bucketMinutes >= 60 ? 'MMM d HH:mm' : 'HH:mm';
  // Fold every remaining surface (schema, auth, …) into "other".
  const known = new Set<string>(SURFACE_SERIES.map((s) => s.key));
  const data = points.map((p) => {
    const row: Record<string, number | string> = {
      time: format(new Date(p.timestamp), timeFormat),
    };
    let other = 0;
    for (const [surface, count] of Object.entries(p.bySurface)) {
      if (known.has(surface) && surface !== 'other') row[surface] = count;
      else other += count;
    }
    if (other > 0) row.other = other;
    return row;
  });

  // Only draw series that actually appear (colors stay entity-bound).
  const active = SURFACE_SERIES.filter((s) => data.some((row) => row[s.key] !== undefined));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsAreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
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
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}
        />
        {active.map((series) => (
          <Area
            key={series.key}
            type="monotone"
            dataKey={series.key}
            name={series.label}
            stackId="traffic"
            stroke="hsl(var(--card))"
            strokeWidth={1.5}
            fill={series.color}
            fillOpacity={0.85}
            isAnimationActive={false}
          />
        ))}
      </RechartsAreaChart>
    </ResponsiveContainer>
  );
}
TrafficAreaChart.displayName = 'TrafficAreaChart';
