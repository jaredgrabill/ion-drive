/**
 * FieldTypePicker — grouped, searchable column-type gallery (Phase 10 / 2A).
 *
 * Full disclosure by design: every entry shows the friendly label, the exact
 * PostgreSQL type it maps to, and the storage limit in plain words ("Short
 * Text — VARCHAR(255), up to 255 characters"), so `text` vs `short_text` is
 * never a mystery. Types come from `/api/v1/schema/column-types` grouped by
 * category; a designer-level **Link to record** pseudo-type is appended when
 * `includeLink` is set (Tier 3A — it composes a FK field + relationship
 * rather than mapping to a column type).
 */

import { Check, ChevronsUpDown, Link2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ColumnType } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Badge, Input, Popover, PopoverContent, PopoverTrigger } from '../ui';

/** Sentinel value the picker emits for the relation pseudo-type (Tier 3). */
export const LINK_TYPE = '__link__';

const GROUP_ORDER = [
  'text',
  'number',
  'datetime',
  'boolean',
  'enum',
  'structured',
  'identity',
  'special',
  'relation',
];

const GROUP_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  datetime: 'Date & Time',
  boolean: 'Boolean',
  enum: 'Select',
  structured: 'Structured',
  identity: 'Identity',
  special: 'Special',
  relation: 'Relations',
};

/** Plain-words storage description for a PG type. */
export function storageBlurb(pg: string): string {
  const varchar = /^VARCHAR\((\d+)\)$/i.exec(pg);
  if (varchar?.[1]) return `up to ${Number(varchar[1]).toLocaleString()} characters`;
  switch (pg.toUpperCase()) {
    case 'TEXT':
      return 'unlimited length';
    case 'INTEGER':
      return 'whole numbers to ±2.1 billion';
    case 'BIGINT':
      return 'whole numbers to ±9.2 quintillion';
    case 'SMALLINT':
      return 'whole numbers to ±32,767';
    case 'NUMERIC(19,4)':
      return 'exact, 4 decimal places';
    case 'NUMERIC(5,2)':
      return 'exact, ±999.99';
    case 'DOUBLE PRECISION':
      return 'floating point (approximate)';
    case 'BOOLEAN':
      return 'true / false';
    case 'DATE':
      return 'date without time';
    case 'TIMESTAMPTZ':
      return 'date + time with timezone';
    case 'TIME':
      return 'time of day';
    case 'UUID':
      return '128-bit unique id';
    case 'SERIAL':
      return 'auto-incrementing integer';
    case 'JSONB':
      return 'arbitrary JSON, indexed';
    case 'TEXT[]':
      return 'list of strings';
    case 'INTEGER[]':
      return 'list of whole numbers';
    case 'INET':
      return 'IPv4 / IPv6 address';
    default:
      return pg;
  }
}

export interface FieldTypePickerProps {
  /** Full records from /schema/column-types. */
  columnTypes: ColumnType[];
  /** Current column type name (or LINK_TYPE). */
  value: string;
  onChange: (value: string) => void;
  /** Offer the "Link to record" pseudo-type (add mode only). */
  includeLink?: boolean;
  disabled?: boolean;
  id?: string;
}

export function FieldTypePicker({
  columnTypes,
  value,
  onChange,
  includeLink = false,
  disabled = false,
  id,
}: FieldTypePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const entries = useMemo(() => {
    const all: ColumnType[] = [...columnTypes];
    if (includeLink) {
      all.push({ name: LINK_TYPE, pg: '', category: 'relation', label: 'Link to record' });
    }
    const term = search.trim().toLowerCase();
    const filtered = term
      ? all.filter(
          (t) =>
            t.label.toLowerCase().includes(term) ||
            t.name.includes(term) ||
            t.pg.toLowerCase().includes(term),
        )
      : all;
    const groups = new Map<string, ColumnType[]>();
    for (const type of filtered) {
      const list = groups.get(type.category) ?? [];
      list.push(type);
      groups.set(type.category, list);
    }
    return [...groups.entries()].sort(
      ([a], [b]) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99),
    );
  }, [columnTypes, includeLink, search]);

  const selected =
    value === LINK_TYPE
      ? { label: 'Link to record', pg: 'relation' }
      : columnTypes.find((t) => t.name === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-expanded={open}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm',
            'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {value === LINK_TYPE && <Link2 className="h-3.5 w-3.5 text-ion-purple" aria-hidden />}
            <span className="truncate">{selected?.label ?? 'Choose a type…'}</span>
            {selected?.pg && value !== LINK_TYPE && (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {selected.pg}
              </span>
            )}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[380px] p-0">
        <div className="border-b border-border p-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search types…"
            className="h-8"
            aria-label="Search column types"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1">
          {entries.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">No matching types</p>
          )}
          {entries.map(([category, types]) => (
            <div key={category}>
              <p className="px-2 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                {GROUP_LABELS[category] ?? category}
              </p>
              {types.map((type) => (
                <button
                  key={type.name}
                  type="button"
                  aria-pressed={type.name === value}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent',
                    type.name === value && 'bg-accent',
                  )}
                  onClick={() => {
                    onChange(type.name);
                    setOpen(false);
                    setSearch('');
                  }}
                >
                  {type.name === LINK_TYPE ? (
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-ion-purple" aria-hidden />
                  ) : (
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        type.name === value ? 'opacity-100' : 'opacity-0',
                      )}
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{type.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {type.name === LINK_TYPE
                        ? 'Foreign key + relationship to another object'
                        : `${type.pg} — ${storageBlurb(type.pg)}`}
                    </span>
                  </span>
                  {type.name !== LINK_TYPE && (
                    <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                      {type.name}
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
FieldTypePicker.displayName = 'FieldTypePicker';
