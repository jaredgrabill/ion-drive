/**
 * GridToolbar — search, filter, sort, field-visibility, refresh, and create
 * controls for the DataGrid.
 *
 * Search is debounced by the parent (the input here is controlled). The
 * Fields popover toggles column visibility (persisted per-object by the
 * grid). The overflow menu offers CSV export of the current page, and
 * copy-API-URL. All state is lifted to DataGrid.
 */

import { Eye, MoreHorizontal, Plus, RotateCw, Search } from 'lucide-react';
import type { FieldDefinition } from '../../lib/types';
import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SimpleTooltip,
} from '../ui';
import { FilterBuilder } from './filter-builder';
import type { FilterCondition, SortRule } from './grid-types';
import { SortBuilder } from './sort-builder';

// --- Types -----------------------------------------------------------

export interface GridToolbarProps {
  fields: FieldDefinition[];
  search: string;
  onSearchChange: (value: string) => void;
  filters: FilterCondition[];
  onFiltersChange: (filters: FilterCondition[]) => void;
  sorts: SortRule[];
  onSortsChange: (sorts: SortRule[]) => void;
  hiddenFields: string[];
  onHiddenFieldsChange: (hidden: string[]) => void;
  onRefresh: () => void;
  onCreate: () => void;
  onExportCsv: () => void;
  onCopyApiUrl: () => void;
}

// --- Component -------------------------------------------------------

export function GridToolbar({
  fields,
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  sorts,
  onSortsChange,
  hiddenFields,
  onHiddenFieldsChange,
  onRefresh,
  onCreate,
  onExportCsv,
  onCopyApiUrl,
}: GridToolbarProps) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {/* Search */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search records…"
          aria-label="Search records"
          className="h-8 w-56 pl-8 text-sm"
        />
      </div>

      <FilterBuilder fields={fields} filters={filters} onChange={onFiltersChange} />
      <SortBuilder fields={fields} sorts={sorts} onChange={onSortsChange} />

      {/* Field visibility */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Eye className="h-3.5 w-3.5" />
            Fields
            {hiddenFields.length > 0 && (
              <Badge variant="secondary" className="px-1.5">
                {fields.length - hiddenFields.length}/{fields.length}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64">
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {fields.map((field) => {
              const visible = !hiddenFields.includes(field.name);
              return (
                // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (renders a button role=checkbox)
                <label
                  key={field.name}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-accent"
                >
                  <Checkbox
                    checked={visible}
                    onCheckedChange={(checked) =>
                      onHiddenFieldsChange(
                        checked === true
                          ? hiddenFields.filter((f) => f !== field.name)
                          : [...hiddenFields, field.name],
                      )
                    }
                    aria-label={`Toggle ${field.displayName} column`}
                  />
                  <span className="truncate">{field.displayName}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {field.columnType}
                  </span>
                </label>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      <div className="ml-auto flex items-center gap-2">
        <SimpleTooltip label="Refresh">
          <Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="Refresh records">
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>

        <Button size="sm" onClick={onCreate} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> New record
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="More actions">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onExportCsv}>Export page as CSV</DropdownMenuItem>
            <DropdownMenuItem onSelect={onCopyApiUrl}>Copy API URL</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
GridToolbar.displayName = 'GridToolbar';
