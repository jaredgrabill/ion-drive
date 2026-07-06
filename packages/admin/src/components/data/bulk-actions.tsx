/**
 * BulkActions — floating action bar shown while grid rows are selected.
 *
 * Slides up from the bottom of the grid with the selection count, a
 * clear-selection button, and destructive bulk delete (which the parent
 * confirms via AlertDialog before mutating).
 */

import { Trash2, X } from 'lucide-react';
import { Button } from '../ui';

// --- Types -----------------------------------------------------------

export interface BulkActionsProps {
  count: number;
  onClear: () => void;
  onDelete: () => void;
}

// --- Component -------------------------------------------------------

export function BulkActions({ count, onClear, onDelete }: BulkActionsProps) {
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2 shadow-lg animate-slide-up"
    >
      <span className="text-sm font-medium">
        {count} {count === 1 ? 'record' : 'records'} selected
      </span>
      <Button variant="destructive" size="sm" onClick={onDelete} className="gap-1.5">
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear selection">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
BulkActions.displayName = 'BulkActions';
