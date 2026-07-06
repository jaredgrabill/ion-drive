/**
 * SortBuilder — multi-column sort editor for the DataGrid toolbar.
 *
 * Each rule is a field + direction; rules apply in order (serialized as
 * `sort=field,-field2`). Column headers offer single-column sorting too —
 * this popover is the power-user path for multi-column sorts. State is
 * lifted to the parent via `onChange(sorts)`.
 */

import { ArrowUpDown, Plus, X } from 'lucide-react';
import type { FieldDefinition } from '../../lib/types';
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, Select } from '../ui';
import type { SortRule } from './grid-types';

// --- Types -----------------------------------------------------------

export interface SortBuilderProps {
  fields: FieldDefinition[];
  sorts: SortRule[];
  onChange: (sorts: SortRule[]) => void;
}

// --- Component -------------------------------------------------------

export function SortBuilder({ fields, sorts, onChange }: SortBuilderProps) {
  const firstField = fields[0]?.name ?? '';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <ArrowUpDown className="h-3.5 w-3.5" />
          Sort
          {sorts.length > 0 && (
            <Badge variant="info" className="px-1.5">
              {sorts.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="flex flex-col gap-2">
          {sorts.length === 0 && <p className="text-sm text-muted-foreground">No sort applied.</p>}
          {sorts.map((sort, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: draft rows have no stable id
            <div key={index} className="flex items-center gap-1.5">
              <Select
                className="flex-1"
                value={sort.field}
                aria-label="Sort field"
                onChange={(e) =>
                  onChange(sorts.map((s, i) => (i === index ? { ...s, field: e.target.value } : s)))
                }
              >
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.displayName}
                  </option>
                ))}
              </Select>
              <Select
                className="w-28"
                value={sort.direction}
                aria-label="Sort direction"
                onChange={(e) =>
                  onChange(
                    sorts.map((s, i) =>
                      i === index ? { ...s, direction: e.target.value as 'asc' | 'desc' } : s,
                    ),
                  )
                }
              >
                <option value="asc">A → Z</option>
                <option value="desc">Z → A</option>
              </Select>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove sort"
                onClick={() => onChange(sorts.filter((_, i) => i !== index))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => onChange([...sorts, { field: firstField, direction: 'asc' }])}
            >
              <Plus className="h-3.5 w-3.5" /> Add sort
            </Button>
            {sorts.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => onChange([])}>
                Clear all
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
SortBuilder.displayName = 'SortBuilder';
