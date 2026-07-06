/**
 * ChartTooltip — shared styled tooltip content for recharts.
 *
 * Popover-styled panel: label on top, one row per series with its color
 * swatch, name in muted ink, and value in primary ink (text never wears the
 * series color — the swatch carries identity). Passed to recharts as
 * `<Tooltip content={<ChartTooltip />} />`.
 */

// --- Types -----------------------------------------------------------

interface TooltipEntry {
  name?: string | number;
  value?: string | number | Array<string | number>;
  color?: string;
}

export interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipEntry[];
  /** Formats each value (e.g. add "ms" or thousands separators). */
  formatValue?: (value: number) => string;
}

// --- Component -------------------------------------------------------

export function ChartTooltip({ active, label, payload, formatValue }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      {label !== undefined && <p className="mb-1 font-medium text-foreground">{label}</p>}
      <div className="flex flex-col gap-0.5">
        {payload.map((entry) => {
          const raw = Array.isArray(entry.value) ? entry.value[0] : entry.value;
          const value =
            typeof raw === 'number' ? (formatValue?.(raw) ?? raw.toLocaleString()) : raw;
          return (
            <div key={String(entry.name)} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-muted-foreground">{entry.name}</span>
              <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">{value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
ChartTooltip.displayName = 'ChartTooltip';
