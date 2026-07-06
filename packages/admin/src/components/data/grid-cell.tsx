/**
 * GridCell — type-aware read-only cell renderer for the DataGrid.
 *
 * Renders each value according to its cell kind (see grid-types.ts):
 * numbers right-aligned and locale-formatted, booleans as a checkbox,
 * enums as badge pills, dates via date-fns, uuids truncated mono with
 * copy-on-hover, JSON as a `{}` chip with key count, emails/urls linked,
 * percentages with a subtle mini-bar, ratings as stars. Null renders as a
 * muted em-dash everywhere.
 */

import { format } from 'date-fns';
import { Copy, ExternalLink } from 'lucide-react';
import type { FieldDefinition } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Badge, Checkbox, toast } from '../ui';
import { type CellKind, NUMERIC_KINDS } from './grid-types';

// --- Types -----------------------------------------------------------

export interface GridCellProps {
  value: unknown;
  kind: CellKind;
  /** Field definition, when available — enables enum choice colors (Phase 10). */
  field?: FieldDefinition;
}

// --- Formatting helpers ------------------------------------------------

function formatNumber(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : String(value);
}

function formatDate(value: unknown, pattern: string): string {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : format(date, pattern);
}

function Null() {
  return <span className="text-muted-foreground/50">—</span>;
}

// --- Component -------------------------------------------------------

export function GridCell({ value, kind, field }: GridCellProps) {
  if (value === null || value === undefined || value === '') return <Null />;

  switch (kind) {
    case 'number':
      return <span className="block text-right tabular-nums">{formatNumber(value)}</span>;

    case 'currency':
      return (
        <span className="block text-right tabular-nums">
          {Number.isFinite(Number(value))
            ? Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD' })
            : String(value)}
        </span>
      );

    case 'percentage': {
      const pct = Math.max(0, Math.min(100, Number(value)));
      return (
        <span className="relative block text-right tabular-nums">
          <span
            aria-hidden
            className="absolute inset-y-0.5 left-0 rounded-sm bg-ion-blue/10"
            style={{ width: `${Number.isFinite(pct) ? pct : 0}%` }}
          />
          <span className="relative">{formatNumber(value)}%</span>
        </span>
      );
    }

    case 'rating': {
      const rating = Math.max(0, Math.min(5, Math.round(Number(value))));
      return (
        <span aria-label={`${rating} of 5 stars`} className="tracking-tight text-ion-amber">
          {'★'.repeat(rating)}
          <span className="text-muted-foreground/40">{'★'.repeat(5 - rating)}</span>
        </span>
      );
    }

    case 'boolean':
      return <Checkbox checked={Boolean(value)} disabled aria-label={value ? 'true' : 'false'} />;

    case 'date':
      return <span className="whitespace-nowrap">{formatDate(value, 'MMM d, yyyy')}</span>;

    case 'datetime':
      return <span className="whitespace-nowrap">{formatDate(value, 'MMM d, yyyy HH:mm')}</span>;

    case 'enum': {
      // Choice colors are presentation-only metadata from the field designer
      // (uiOptions.choiceColors, Phase 10).
      const colors = (field?.uiOptions?.choiceColors ?? {}) as Record<string, string>;
      const color = colors[String(value)];
      if (color) {
        return (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
            style={{
              borderColor: `${color}66`,
              backgroundColor: `${color}1f`,
            }}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: color }}
            />
            {String(value)}
          </span>
        );
      }
      return <Badge variant="info">{String(value)}</Badge>;
    }

    case 'uuid':
      return (
        <span className="group/uuid inline-flex max-w-full items-center gap-1 font-mono text-xs">
          <span className="truncate">{String(value).slice(0, 8)}…</span>
          <button
            type="button"
            aria-label="Copy id"
            className="opacity-0 transition-opacity group-hover/uuid:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(String(value));
              toast('Copied to clipboard');
            }}
          >
            <Copy className="h-3 w-3 text-muted-foreground" />
          </button>
        </span>
      );

    case 'json': {
      const keys = typeof value === 'object' && value !== null ? Object.keys(value).length : 0;
      return (
        <span
          className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground"
          title={JSON.stringify(value, null, 2)}
        >
          {'{ }'}
          <Badge variant="outline" className="px-1.5">
            {keys}
          </Badge>
        </span>
      );
    }

    case 'email':
      return (
        <a
          href={`mailto:${String(value)}`}
          className="truncate text-ion-blue hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value)}
        </a>
      );

    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1 text-ion-blue hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="truncate">{String(value)}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        </a>
      );

    default: {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return (
        <span className={cn('block truncate', NUMERIC_KINDS.has(kind) && 'text-right')}>
          {text}
        </span>
      );
    }
  }
}
GridCell.displayName = 'GridCell';
