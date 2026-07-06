/**
 * ColumnHeader — sortable, resizable header cell with type icon and
 * right-click context menu for the DataGrid.
 *
 * Click cycles sort asc → desc → none (arrow indicator shown). A drag
 * handle on the right edge resizes the column (min 80px; width lifted to
 * the grid's per-object prefs). The context menu offers explicit sort and
 * hide-column actions.
 */

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useCallback, useRef } from 'react';
import type { FieldDefinition } from '../../lib/types';
import { cn } from '../../lib/utils';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui';
import { type CellKind, cellKindOf } from './grid-types';

// --- Type icons --------------------------------------------------------

const KIND_ICONS: Record<CellKind, string> = {
  text: 'Aa',
  longText: 'Aa',
  number: '#',
  currency: '$',
  percentage: '%',
  rating: '★',
  boolean: '☐',
  date: '📅',
  datetime: '📅',
  enum: '◉',
  uuid: '#id',
  json: '{}',
  email: '@',
  url: '↗',
};

// --- Types -----------------------------------------------------------

export interface ColumnHeaderProps {
  field: FieldDefinition;
  width: number;
  sortDirection: 'asc' | 'desc' | null;
  onSortCycle: () => void;
  onSortSet: (direction: 'asc' | 'desc') => void;
  onHide: () => void;
  onResize: (width: number) => void;
}

const MIN_WIDTH = 80;

// --- Component -------------------------------------------------------

export function ColumnHeader({
  field,
  width,
  sortDirection,
  onSortCycle,
  onSortSet,
  onHide,
  onResize,
}: ColumnHeaderProps) {
  const kind = cellKindOf(field.columnType);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      startX.current = e.clientX;
      startWidth.current = width;
      const onMove = (move: PointerEvent) => {
        onResize(Math.max(MIN_WIDTH, startWidth.current + (move.clientX - startX.current)));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [onResize, width],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <th
          scope="col"
          style={{ width, minWidth: width, maxWidth: width }}
          aria-sort={
            sortDirection === 'asc'
              ? 'ascending'
              : sortDirection === 'desc'
                ? 'descending'
                : undefined
          }
          className="group/col relative border-b border-border bg-muted/50 p-0 text-left font-medium text-muted-foreground select-none"
        >
          <button
            type="button"
            onClick={onSortCycle}
            className="flex h-8 w-full items-center gap-1.5 truncate px-3 text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
              {KIND_ICONS[kind]}
            </span>
            <span className="truncate">{field.displayName}</span>
            {sortDirection === 'asc' && <ArrowUp className="h-3 w-3 shrink-0 text-ion-blue" />}
            {sortDirection === 'desc' && <ArrowDown className="h-3 w-3 shrink-0 text-ion-blue" />}
          </button>
          {/* Resize handle — pointer-only affordance; widths are also settable via the Fields menu */}
          <span
            aria-hidden
            onPointerDown={onResizeStart}
            className={cn(
              'absolute top-0 right-0 h-full w-1 cursor-col-resize opacity-0 transition-opacity',
              'group-hover/col:opacity-100 hover:bg-ion-blue/60',
            )}
          />
        </th>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onSortSet('asc')}>Sort A → Z</ContextMenuItem>
        <ContextMenuItem onSelect={() => onSortSet('desc')}>Sort Z → A</ContextMenuItem>
        <ContextMenuItem onSelect={onHide}>Hide column</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
ColumnHeader.displayName = 'ColumnHeader';
