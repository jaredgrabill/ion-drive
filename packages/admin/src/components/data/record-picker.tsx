/**
 * RecordPicker — searchable linked-record selector (Phase 10 / Tier 3B).
 *
 * Popover with a debounced search input driving the Phase 7 `q=` free-text
 * query against the target object; results list the target's display value.
 * Selecting a row emits its id (the FK value); a clear action emits ''.
 * Used by the grid's inline editor and the RecordSheet for link fields.
 */

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Link2, X } from 'lucide-react';
import { useState } from 'react';
import { useDebounce } from '../../hooks';
import { api } from '../../lib/api';
import { displayFieldOf, recordLabelOf } from '../../lib/record-label';
import { cn } from '../../lib/utils';
import { Input, Popover, PopoverContent, PopoverTrigger, Skeleton } from '../ui';

export interface RecordPickerProps {
  /** Target object name the FK points at. */
  targetObject: string;
  /** Current FK value ('' = none). */
  value: string;
  onChange: (id: string) => void;
  /** Display-field override (`uiOptions.displayField` on the link field). */
  displayField?: string;
  /** Trigger label when no record is selected (default "None"). */
  placeholder?: string;
  'aria-label'?: string;
}

export function RecordPicker({
  targetObject,
  value,
  onChange,
  displayField,
  placeholder = 'None',
  'aria-label': ariaLabel,
}: RecordPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const term = useDebounce(search, 250);

  const target = useQuery({
    queryKey: ['object', targetObject],
    queryFn: () => api.getObject(targetObject),
    staleTime: 60_000,
  });
  const field = displayFieldOf(target.data, displayField);

  const results = useQuery({
    queryKey: ['record-picker', targetObject, term],
    queryFn: () =>
      api.listRecords(targetObject, `?pageSize=10${term ? `&q=${encodeURIComponent(term)}` : ''}`),
    enabled: open,
  });

  const current = useQuery({
    queryKey: ['record-chip', targetObject, value],
    queryFn: () => api.getRecord(targetObject, value),
    enabled: value !== '',
    staleTime: 30_000,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-label={ariaLabel ?? `Pick a ${targetObject} record`}
          className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2.5 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Link2 className="h-3 w-3 shrink-0 text-ion-purple" aria-hidden />
            <span className="truncate">
              {value === '' ? placeholder : recordLabelOf(current.data, field)}
            </span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-0">
        <div className="border-b border-border p-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${target.data?.displayName ?? targetObject}…`}
            className="h-8"
            aria-label="Search records"
          />
        </div>
        <div className="max-h-[260px] overflow-y-auto p-1">
          {value !== '' && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden /> Clear link
            </button>
          )}
          {results.isLoading && (
            <div className="flex flex-col gap-1 p-1">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
            </div>
          )}
          {results.data?.data.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">No records found</p>
          )}
          {(results.data?.data ?? []).map((record) => {
            const id = String(record.id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={id === value}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent',
                  id === value && 'bg-accent',
                )}
                onClick={() => {
                  onChange(id);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0', id === value ? 'opacity-100' : 'opacity-0')}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{recordLabelOf(record, field)}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {id.slice(0, 8)}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
RecordPicker.displayName = 'RecordPicker';
