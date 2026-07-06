/**
 * SparkLine — tiny inline SVG trend line for stat cards.
 *
 * Pure SVG (no recharts) so it costs nothing at 100×28px. Decorative
 * (`aria-hidden`) — the stat card's number carries the information.
 */

// --- Types -----------------------------------------------------------

export interface SparkLineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Stroke color (CSS color; defaults to chart-1). */
  color?: string;
}

// --- Component -------------------------------------------------------

export function SparkLine({
  values,
  width = 100,
  height = 28,
  color = 'var(--chart-1)',
}: SparkLineProps) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map(
      (v, i) =>
        `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / range) * (height - 4)).toFixed(1)}`,
    )
    .join(' ');

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative (aria-hidden) — the stat number carries the info
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
SparkLine.displayName = 'SparkLine';
