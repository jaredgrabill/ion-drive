/**
 * FilterBuilder — composable visual filter editor for the DataGrid toolbar.
 *
 * Renders a Filter popover where users compose field → operator → value
 * conditions. Conditions map 1:1 to the Ion Drive REST query operators
 * (`[eq]`, `[gt]`, `[contains]`, …) from Phase 7. Multiple filters compose
 * with AND; the active filter count is shown as a badge on the trigger.
 * State is lifted to the parent via `onChange(filters)`.
 */

import { ListFilter, Plus, X } from 'lucide-react';
import type { FieldDefinition } from '../../lib/types';
import { Badge, Button, Input, Popover, PopoverContent, PopoverTrigger, Select } from '../ui';
import { type FilterCondition, cellKindOf, operatorsFor } from './grid-types';

// --- Types -----------------------------------------------------------

export interface FilterBuilderProps {
  fields: FieldDefinition[];
  filters: FilterCondition[];
  onChange: (filters: FilterCondition[]) => void;
}

// --- Component -------------------------------------------------------

export function FilterBuilder({ fields, filters, onChange }: FilterBuilderProps) {
  const firstField = fields[0]?.name ?? '';

  const update = (index: number, patch: Partial<FilterCondition>) =>
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <ListFilter className="h-3.5 w-3.5" />
          Filter
          {filters.length > 0 && (
            <Badge variant="info" className="px-1.5">
              {filters.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem]">
        <div className="flex flex-col gap-2">
          {filters.length === 0 && (
            <p className="text-sm text-muted-foreground">No filters applied.</p>
          )}
          {filters.map((filter, index) => {
            const field = fields.find((f) => f.name === filter.field);
            const kind = cellKindOf(field?.columnType ?? 'text');
            const operators = operatorsFor(kind);
            const operator = operators.find((o) => o.op === filter.op) ?? operators[0];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: draft rows have no stable id
              <div key={index} className="flex items-center gap-1.5">
                <Select
                  className="w-36"
                  value={filter.field}
                  aria-label="Filter field"
                  onChange={(e) => {
                    const nextField = fields.find((f) => f.name === e.target.value);
                    const nextOps = operatorsFor(cellKindOf(nextField?.columnType ?? 'text'));
                    update(index, {
                      field: e.target.value,
                      op: nextOps.some((o) => o.op === filter.op)
                        ? filter.op
                        : (nextOps[0]?.op ?? 'eq'),
                    });
                  }}
                >
                  {fields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.displayName}
                    </option>
                  ))}
                </Select>
                <Select
                  className="w-32"
                  value={filter.op}
                  aria-label="Filter operator"
                  onChange={(e) => update(index, { op: e.target.value })}
                >
                  {operators.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {operator?.hasValue !== false ? (
                  kind === 'boolean' ? (
                    <Select
                      className="flex-1"
                      value={filter.value}
                      aria-label="Filter value"
                      onChange={(e) => update(index, { value: e.target.value })}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    <Input
                      className="h-9 flex-1"
                      value={filter.value}
                      placeholder={filter.op === 'in' ? 'a,b,c' : 'value'}
                      aria-label="Filter value"
                      onChange={(e) => update(index, { value: e.target.value })}
                    />
                  )
                ) : (
                  <span className="flex-1" />
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove filter"
                  onClick={() => onChange(filters.filter((_, i) => i !== index))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
          <div className="flex items-center justify-between pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => onChange([...filters, { field: firstField, op: 'eq', value: '' }])}
            >
              <Plus className="h-3.5 w-3.5" /> Add filter
            </Button>
            {filters.length > 0 && (
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
FilterBuilder.displayName = 'FilterBuilder';
