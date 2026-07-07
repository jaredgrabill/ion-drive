/**
 * DataGrid — Airtable-grade spreadsheet editor for a data object's records.
 *
 * Orchestrates the whole grid experience:
 *  - Server-driven querying (Phase 7 REST syntax) — debounced free-text
 *    search (`q=`), composable filters (`field[op]=`), multi-column sort,
 *    and page/pageSize pagination with total counts.
 *  - TanStack Table for the row/selection model; @tanstack/react-virtual
 *    renders only visible rows so large pages stay smooth.
 *  - Inline editing: Enter/double-click edits the focused cell, Escape
 *    cancels, Tab commits and moves on. Saves are optimistic single-field
 *    PATCHes with rollback + toast on failure; an ion-blue dot marks
 *    in-flight cells.
 *  - Keyboard navigation: arrow keys move the focused cell (roving focus),
 *    Space toggles booleans, Delete clears a value.
 *  - Column layout (visibility + widths) persists per-object via the
 *    zustand grid store; headers sort on click, resize by drag, and expose
 *    a right-click context menu.
 *  - Row selection drives the BulkActions bar (bulk delete with an
 *    AlertDialog confirm). Row expand buttons open the RecordSheet.
 *
 * Loading shows a skeleton grid with the same row dimensions as real data
 * (zero layout shift).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type RowSelectionState,
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Expand, Inbox } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDebounce } from '../../hooks';
import { ApiError, api } from '../../lib/api';
import { consumeGridSearchPrefill } from '../../lib/grid-prefill';
import type { DataObjectDefinition, FieldDefinition, PaginationMeta } from '../../lib/types';
import { cn } from '../../lib/utils';
import {
  AlertDialog,
  Button,
  Checkbox,
  EmptyState,
  Select,
  SimpleTooltip,
  Skeleton,
  toast,
} from '../ui';
import { BulkActions } from './bulk-actions';
import { ColumnHeader } from './column-header';
import { GridCell } from './grid-cell';
import { GridCellEditor, coerceValue, editValueOf } from './grid-cell-editor';
import { useGridStore, useObjectGridPrefs } from './grid-store';
import { GridToolbar } from './grid-toolbar';
import {
  type FilterCondition,
  type GridRow,
  type SortRule,
  buildQueryString,
  cellKindOf,
  linkTargetOf,
  linkedRelationshipOf,
  m2mRelationshipsOf,
} from './grid-types';
import { RecordChip } from './record-chip';
import { RecordPicker } from './record-picker';
import { RelationChipList } from './relation-chips';

// Code-split: the RecordSheet pulls in react-hook-form + zod, which the
// grid itself doesn't need until a record is opened.
const RecordSheet = lazy(() => import('./record-sheet').then((m) => ({ default: m.RecordSheet })));

// --- Constants ---------------------------------------------------------

const ROW_HEIGHT = 36;
const DEFAULT_COLUMN_WIDTH = 180;
const PAGE_SIZES = [25, 50, 100] as const;

interface EditingCell {
  rowId: string;
  field: string;
  value: string;
}

interface FocusedCell {
  row: number;
  col: number;
}

// --- Pure helpers --------------------------------------------------------

/** Tri-state header checkbox value for the select-all control. */
function selectAllState(allSelected: boolean, someSelected: boolean): boolean | 'indeterminate' {
  if (allSelected) return true;
  return someSelected ? 'indeterminate' : false;
}

/** CSV-quotes a cell value (objects JSON-stringified, quotes doubled). */
function csvCell(v: unknown): string {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Handles a navigation/edit key on the grid container (roving focus).
 * Extracted from the component so the keyboard contract reads as one unit:
 * arrows/Tab move, Enter edits, Space toggles booleans, Delete clears.
 */
function handleGridKey(
  e: React.KeyboardEvent,
  ctx: {
    focused: FocusedCell;
    rows: GridRow[];
    visibleFields: FieldDefinition[];
    setFocused: (cell: FocusedCell) => void;
    beginEdit: (rowIndex: number, colIndex: number) => void;
    saveCell: (vars: { rowId: string; field: string; value: unknown }) => void;
  },
): void {
  const { focused, rows, visibleFields, setFocused, beginEdit, saveCell } = ctx;
  const maxRow = rows.length - 1;
  const maxCol = visibleFields.length - 1;
  const move = (dr: number, dc: number) => {
    e.preventDefault();
    setFocused({
      row: Math.max(0, Math.min(maxRow, focused.row + dr)),
      col: Math.max(0, Math.min(maxCol, focused.col + dc)),
    });
  };
  switch (e.key) {
    case 'ArrowUp':
      move(-1, 0);
      return;
    case 'ArrowDown':
      move(1, 0);
      return;
    case 'ArrowLeft':
      move(0, -1);
      return;
    case 'ArrowRight':
      move(0, 1);
      return;
    case 'Tab':
      move(0, e.shiftKey ? -1 : 1);
      return;
    case 'Enter':
      e.preventDefault();
      beginEdit(focused.row, focused.col);
      return;
    case ' ': {
      const field = visibleFields[focused.col];
      const row = rows[focused.row];
      if (field && row && cellKindOf(field.columnType) === 'boolean') {
        e.preventDefault();
        saveCell({ rowId: String(row.id), field: field.name, value: !row[field.columnName] });
      }
      return;
    }
    case 'Delete':
    case 'Backspace': {
      const field = visibleFields[focused.col];
      const row = rows[focused.row];
      if (field && row && !field.isPrimary) {
        e.preventDefault();
        saveCell({ rowId: String(row.id), field: field.name, value: null });
      }
      return;
    }
    default:
      return;
  }
}

// --- Component ---------------------------------------------------------

export interface DataGridProps {
  object: DataObjectDefinition;
}

export function DataGrid({ object }: DataGridProps) {
  const queryClient = useQueryClient();

  // --- Query state ---
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  // A one-shot prefill (command palette record search) seeds the search box.
  const [searchInput, setSearchInput] = useState(() => consumeGridSearchPrefill(object.name) ?? '');
  const search = useDebounce(searchInput, 300);
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [sorts, setSorts] = useState<SortRule[]>([]);

  // --- Layout prefs (persisted per object) ---
  const prefs = useObjectGridPrefs(object.name);
  const setHidden = useGridStore((s) => s.setHidden);
  const setWidth = useGridStore((s) => s.setWidth);

  // --- Ephemeral grid state ---
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [focused, setFocused] = useState<FocusedCell | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<{ mode: 'create' } | { mode: 'edit'; row: GridRow } | null>(
    null,
  );
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  const fields = useMemo(() => object.fields.filter((f) => !f.isSystem), [object.fields]);
  const visibleFields = useMemo(
    () => fields.filter((f) => !prefs.hidden.includes(f.name)),
    [fields, prefs.hidden],
  );
  // m2m relationships render as read-only chip columns after the fields,
  // fed by expand= on the list query (Phase 13). Editing lives in the sheet.
  const m2mRels = useMemo(() => m2mRelationshipsOf(object), [object]);

  // Reset to page 1 whenever the query shape changes.
  const queryString = buildQueryString({
    page,
    pageSize,
    search,
    filters,
    sorts,
    expand: m2mRels.map((rel) => rel.name),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional page reset on query change
  useEffect(() => {
    setPage(1);
  }, [search, filters, sorts, pageSize]);

  // --- Data ---
  const queryKey = ['records', object.name, queryString];
  const records = useQuery({
    queryKey,
    queryFn: () => api.listRecords(object.name, queryString),
    placeholderData: (prev) => prev,
  });
  const rows = useMemo(() => records.data?.data ?? [], [records.data]);
  const pagination = records.data?.pagination;

  // --- Table model (selection + row ids) ---
  const columnHelper = createColumnHelper<GridRow>();
  const columns = useMemo(
    () => [
      columnHelper.display({ id: 'select' }),
      ...visibleFields.map((f) => columnHelper.display({ id: f.name })),
    ],
    [columnHelper, visibleFields],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => String(row.id),
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
  });
  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);

  // --- Virtualized rows ---
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const padTop = virtualRows.length > 0 ? (virtualRows[0]?.start ?? 0) : 0;
  const padBottom =
    virtualRows.length > 0
      ? virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0)
      : 0;

  // --- Cell save (optimistic PATCH with rollback) ---
  const saveCell = useMutation({
    mutationFn: ({ rowId, field, value }: { rowId: string; field: string; value: unknown }) =>
      api.updateRecord(object.name, rowId, { [field]: value }),
    onMutate: async ({ rowId, field, value }) => {
      const cellKey = `${rowId}:${field}`;
      setPendingCells((prev) => new Set(prev).add(cellKey));
      const previous = queryClient.getQueryData(queryKey);
      const column = fields.find((f) => f.name === field)?.columnName ?? field;
      queryClient.setQueryData(
        queryKey,
        (old: { data: GridRow[]; pagination: unknown } | undefined) =>
          old && {
            ...old,
            data: old.data.map((r) => (String(r.id) === rowId ? { ...r, [column]: value } : r)),
          },
      );
      return { previous, cellKey };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast.error(
        `Failed to save: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      );
    },
    onSettled: (_data, _err, _vars, context) => {
      if (context?.cellKey) {
        setPendingCells((prev) => {
          const next = new Set(prev);
          next.delete(context.cellKey);
          return next;
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['records', object.name] });
    },
  });

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteRecords(object.name, ids),
    onSuccess: (result) => {
      toast.success(`Deleted ${result.count} ${result.count === 1 ? 'record' : 'records'}`);
      setRowSelection({});
      void queryClient.invalidateQueries({ queryKey: ['records', object.name] });
    },
    onError: (error) =>
      toast.error(
        `Failed to delete: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  // --- Editing helpers ---
  const beginEdit = useCallback(
    (rowIndex: number, colIndex: number) => {
      const row = rows[rowIndex];
      const field = visibleFields[colIndex];
      if (!row || !field || field.isPrimary) return;
      const kind = cellKindOf(field.columnType);
      // Raw uuids are immutable ids — but a link field's FK edits via the picker.
      if (kind === 'uuid' && !linkedRelationshipOf(object, field)) return;
      setEditing({
        rowId: String(row.id),
        field: field.name,
        value: editValueOf(row[field.columnName]),
      });
    },
    [rows, visibleFields, object],
  );

  const commitEdit = useCallback(() => {
    if (!editing) return;
    const field = fields.find((f) => f.name === editing.field);
    if (field) {
      const kind = cellKindOf(field.columnType);
      saveCell.mutate({
        rowId: editing.rowId,
        field: editing.field,
        value: coerceValue(kind, editing.value),
      });
    }
    setEditing(null);
  }, [editing, fields, saveCell]);

  // Focus the DOM cell whenever the focused coordinate changes.
  useEffect(() => {
    if (!focused || editing) return;
    const cell = scrollRef.current?.querySelector<HTMLElement>(
      `[data-cell="${focused.row}-${focused.col}"]`,
    );
    cell?.focus();
  }, [focused, editing]);

  // --- Keyboard navigation ---
  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return; // the editor handles its own keys
      if (!focused) return;
      handleGridKey(e, {
        focused,
        rows,
        visibleFields,
        setFocused,
        beginEdit,
        saveCell: saveCell.mutate,
      });
    },
    [editing, focused, rows, visibleFields, beginEdit, saveCell],
  );

  // --- Toolbar actions ---
  const exportCsv = () => {
    const header = visibleFields.map((f) => f.displayName).join(',');
    const lines = rows.map((row) => visibleFields.map((f) => csvCell(row[f.columnName])).join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${object.name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} records`);
  };

  const copyApiUrl = () => {
    navigator.clipboard?.writeText(`${window.location.origin}/api/v1/data/${object.name}`);
    toast('Copied API URL to clipboard');
  };

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['records', object.name] });

  // --- Sort helpers for headers ---
  const headerSort = (fieldName: string): 'asc' | 'desc' | null =>
    sorts.find((s) => s.field === fieldName)?.direction ?? null;
  const cycleSort = (fieldName: string) => {
    const current = headerSort(fieldName);
    if (current === null) setSorts([{ field: fieldName, direction: 'asc' }]);
    else if (current === 'asc') setSorts([{ field: fieldName, direction: 'desc' }]);
    else setSorts([]);
  };

  const widthOf = (f: FieldDefinition) => prefs.widths[f.name] ?? DEFAULT_COLUMN_WIDTH;

  // --- Render ---
  return (
    <div>
      <GridToolbar
        fields={fields}
        search={searchInput}
        onSearchChange={setSearchInput}
        filters={filters}
        onFiltersChange={setFilters}
        sorts={sorts}
        onSortsChange={setSorts}
        hiddenFields={prefs.hidden}
        onHiddenFieldsChange={(hidden) => setHidden(object.name, hidden)}
        onRefresh={invalidate}
        onCreate={() => setSheet({ mode: 'create' })}
        onExportCsv={exportCsv}
        onCopyApiUrl={copyApiUrl}
      />

      {records.isLoading ? (
        <GridSkeleton fields={visibleFields} />
      ) : rows.length === 0 ? (
        <GridEmptyState
          hasQuery={Boolean(search) || filters.length > 0}
          onCreate={() => setSheet({ mode: 'create' })}
        />
      ) : (
        <div
          ref={scrollRef}
          className="max-h-[65vh] overflow-auto rounded-lg border border-border bg-surface-sunken"
          onKeyDown={onGridKeyDown}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: interactive spreadsheet grid */}
          <table className="w-full border-separate border-spacing-0 text-sm" role="grid">
            <thead className="sticky top-0 z-10">
              <tr>
                <th
                  scope="col"
                  className="w-16 border-b border-border bg-muted/50 px-2"
                  style={{ width: 64, minWidth: 64 }}
                >
                  <Checkbox
                    checked={selectAllState(
                      table.getIsAllRowsSelected(),
                      table.getIsSomeRowsSelected(),
                    )}
                    onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)}
                    aria-label="Select all rows"
                  />
                </th>
                {visibleFields.map((field) => (
                  <ColumnHeader
                    key={field.name}
                    field={field}
                    width={widthOf(field)}
                    sortDirection={headerSort(field.name)}
                    onSortCycle={() => cycleSort(field.name)}
                    onSortSet={(dir) => setSorts([{ field: field.name, direction: dir }])}
                    onHide={() => setHidden(object.name, [...prefs.hidden, field.name])}
                    onResize={(w) => setWidth(object.name, field.name, w)}
                  />
                ))}
                {m2mRels.map((rel) => (
                  <th
                    key={`rel-${rel.name}`}
                    scope="col"
                    className="border-b border-border bg-muted/50 px-3 py-2 text-left font-medium text-muted-foreground"
                    style={{ width: 220, minWidth: 220 }}
                  >
                    <span className="flex items-center gap-1.5 text-xs">
                      {rel.displayName}
                      <span className="rounded-full bg-ion-purple/10 px-1.5 text-[10px] text-ion-purple">
                        m2m
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {padTop > 0 && (
                <tr aria-hidden>
                  <td
                    style={{ height: padTop }}
                    colSpan={visibleFields.length + m2mRels.length + 1}
                  />
                </tr>
              )}
              {virtualRows.map((virtualRow) => {
                const rowIndex = virtualRow.index;
                const row = rows[rowIndex];
                if (!row) return null;
                const rowId = String(row.id);
                const tableRow = table.getRowModel().rows[rowIndex];
                return (
                  <tr
                    key={rowId}
                    className={cn(
                      'group/row bg-card transition-colors hover:bg-muted/40',
                      tableRow?.getIsSelected() && 'bg-ion-blue/5',
                    )}
                    style={{ height: ROW_HEIGHT }}
                  >
                    <td className="border-b border-border/60 px-2" style={{ width: 64 }}>
                      <span className="flex items-center gap-1">
                        <Checkbox
                          checked={tableRow?.getIsSelected() ?? false}
                          onCheckedChange={(v) => tableRow?.toggleSelected(v === true)}
                          aria-label={`Select row ${rowId}`}
                        />
                        <SimpleTooltip label="Open record">
                          <button
                            type="button"
                            aria-label="Open record"
                            className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100"
                            onClick={() => setSheet({ mode: 'edit', row })}
                          >
                            <Expand className="h-3.5 w-3.5 text-muted-foreground" />
                          </button>
                        </SimpleTooltip>
                      </span>
                    </td>
                    {visibleFields.map((field, colIndex) => {
                      const isPending = pendingCells.has(`${rowId}:${field.name}`);
                      return (
                        // Roving-focus spreadsheet cell: focus moves via the grid's
                        // keyboard handler (arrows/Enter/Escape on the container).
                        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the grid container (onGridKeyDown)
                        <td
                          key={field.name}
                          tabIndex={focused?.row === rowIndex && focused.col === colIndex ? 0 : -1}
                          data-cell={`${rowIndex}-${colIndex}`}
                          style={{
                            width: widthOf(field),
                            minWidth: widthOf(field),
                            maxWidth: widthOf(field),
                          }}
                          className={cn(
                            'relative border-b border-border/60 px-3 py-1.5 outline-none',
                            'focus:ring-2 focus:ring-ion-blue/60 focus:ring-inset',
                          )}
                          onClick={() => setFocused({ row: rowIndex, col: colIndex })}
                          onDoubleClick={() => beginEdit(rowIndex, colIndex)}
                        >
                          <GridDataCellContent
                            object={object}
                            field={field}
                            row={row}
                            rowId={rowId}
                            editing={editing}
                            setEditing={setEditing}
                            commitEdit={commitEdit}
                            saveCell={saveCell.mutate}
                          />
                          {isPending && (
                            <span
                              aria-hidden
                              className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-ion-blue"
                            />
                          )}
                        </td>
                      );
                    })}
                    {m2mRels.map((rel) => (
                      // Read-only chip cell; open the record sheet to edit links.
                      // biome-ignore lint/a11y/useKeyWithClickEvents: mouse shortcut only — the sheet also opens via the row's Open button
                      <td
                        key={`rel-${rel.name}`}
                        className="cursor-pointer border-b border-border/60 px-3 py-1.5"
                        style={{ width: 220, minWidth: 220, maxWidth: 220 }}
                        onClick={() => setSheet({ mode: 'edit', row })}
                      >
                        <RelationChipList
                          targetObject={linkTargetOf(object, rel)}
                          records={row[rel.name]}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {padBottom > 0 && (
                <tr aria-hidden>
                  <td
                    style={{ height: padBottom }}
                    colSpan={visibleFields.length + m2mRels.length + 1}
                  />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pagination && rows.length > 0 && (
        <GridPagination
          pagination={pagination}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
          onPrevious={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
        />
      )}

      <BulkActions
        count={selectedIds.length}
        onClear={() => setRowSelection({})}
        onDelete={() => setConfirmBulkDelete(true)}
      />
      <AlertDialog
        open={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        title="Delete selected records"
        description={`This will permanently delete ${selectedIds.length} ${
          selectedIds.length === 1 ? 'record' : 'records'
        }. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => bulkDelete.mutate(selectedIds)}
      />

      {sheet && (
        <Suspense fallback={null}>
          <RecordSheet
            object={object}
            record={sheet.mode === 'edit' ? sheet.row : null}
            onClose={() => setSheet(null)}
            onSaved={() => {
              setSheet(null);
              invalidate();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
DataGrid.displayName = 'DataGrid';

// --- Cell content --------------------------------------------------------

interface GridDataCellContentProps {
  object: DataObjectDefinition;
  field: FieldDefinition;
  row: GridRow;
  rowId: string;
  editing: EditingCell | null;
  setEditing: (editing: EditingCell | null) => void;
  commitEdit: () => void;
  saveCell: (vars: { rowId: string; field: string; value: unknown }) => void;
}

/**
 * The value area of one grid cell: the type-aware read renderer (GridCell /
 * RecordChip for link fields) or, while this cell is being edited, the inline
 * editor (GridCellEditor / RecordPicker — picking a record commits immediately).
 */
function GridDataCellContent({
  object,
  field,
  row,
  rowId,
  editing,
  setEditing,
  commitEdit,
  saveCell,
}: GridDataCellContentProps) {
  const kind = cellKindOf(field.columnType);
  const linkRel = linkedRelationshipOf(object, field);
  const isEditing = editing?.rowId === rowId && editing.field === field.name;

  if (isEditing && editing) {
    if (linkRel) {
      // Linked-record fields edit through the picker; choosing a record
      // commits immediately.
      return (
        <RecordPicker
          targetObject={linkTargetOf(object, linkRel)}
          value={editing.value}
          displayField={field.uiOptions?.displayField as string | undefined}
          onChange={(id) => {
            saveCell({ rowId, field: field.name, value: id === '' ? null : id });
            setEditing(null);
          }}
          aria-label={`Link ${field.displayName}`}
        />
      );
    }
    return (
      <GridCellEditor
        field={field}
        value={editing.value}
        onChange={(value) => setEditing({ ...editing, value })}
        onCommit={commitEdit}
        onCancel={() => setEditing(null)}
        autoFocus
      />
    );
  }

  if (linkRel) {
    return (
      <RecordChip
        targetObject={linkTargetOf(object, linkRel)}
        id={row[field.columnName]}
        displayField={field.uiOptions?.displayField as string | undefined}
      />
    );
  }
  return <GridCell value={row[field.columnName]} kind={kind} field={field} />;
}
GridDataCellContent.displayName = 'GridDataCellContent';

// --- Empty state ---------------------------------------------------------

/** Empty grid body: "no records yet" (with create CTA) vs "no matches". */
function GridEmptyState({ hasQuery, onCreate }: { hasQuery: boolean; onCreate: () => void }) {
  return (
    <EmptyState
      icon={<Inbox className="h-8 w-8" />}
      title={hasQuery ? 'No matching records' : 'No records yet'}
      hint={
        hasQuery ? 'Try adjusting your search or filters.' : 'Add your first record to get started.'
      }
      action={
        !hasQuery ? (
          <Button size="sm" onClick={onCreate}>
            New record
          </Button>
        ) : undefined
      }
    />
  );
}
GridEmptyState.displayName = 'GridEmptyState';

// --- Pagination footer -----------------------------------------------------

interface GridPaginationProps {
  pagination: PaginationMeta;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  onPrevious: () => void;
  onNext: () => void;
}

/** Record range summary + page-size select + Previous/Next controls. */
function GridPagination({
  pagination,
  pageSize,
  onPageSizeChange,
  onPrevious,
  onNext,
}: GridPaginationProps) {
  const from = (pagination.page - 1) * pagination.pageSize + 1;
  const to = Math.min(pagination.page * pagination.pageSize, pagination.totalCount);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <span>
        Showing {from.toLocaleString()}–{to.toLocaleString()} of{' '}
        {pagination.totalCount.toLocaleString()} records
      </span>
      <div className="flex items-center gap-2">
        <Select
          className="w-24"
          value={String(pageSize)}
          aria-label="Page size"
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={!pagination.hasPreviousPage}
          onClick={onPrevious}
        >
          Previous
        </Button>
        <span>
          Page {pagination.page} of {Math.max(pagination.totalPages, 1)}
        </span>
        <Button variant="outline" size="sm" disabled={!pagination.hasNextPage} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}
GridPagination.displayName = 'GridPagination';

// --- Skeleton ----------------------------------------------------------

function GridSkeleton({ fields }: { fields: FieldDefinition[] }) {
  const columns = Math.max(fields.length, 3);
  return (
    <div className="overflow-hidden rounded-lg border border-border" aria-hidden>
      <div className="flex gap-px bg-muted/50 p-2">
        {Array.from({ length: columns }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
        <div key={r} className="flex gap-px border-t border-border/60 p-2">
          {Array.from({ length: columns }).map((_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <Skeleton key={c} className="h-5 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
GridSkeleton.displayName = 'GridSkeleton';
