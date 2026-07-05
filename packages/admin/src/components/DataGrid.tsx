/**
 * DataGrid — a functional (not-yet-fancy) record browser + editor.
 *
 * Lists records for an object with pagination, and supports create/edit/delete
 * through a per-field form. Inputs are chosen from each field's column type.
 * This is intentionally utilitarian; a richer Airtable-style grid comes in a
 * later phase (per the Phase 3 plan).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import type { DataObjectDefinition, FieldDefinition } from '../lib/types';
import { Button, Dialog, EmptyState, Input, Label, Spinner, Textarea } from './ui';

const PAGE_SIZE = 25;

export function DataGrid({ object }: { object: DataObjectDefinition }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState(false);

  const records = useQuery({
    queryKey: ['records', object.name, page],
    queryFn: () => api.listRecords(object.name, `?page=${page}&pageSize=${PAGE_SIZE}`),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteRecord(object.name, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['records', object.name] }),
  });

  const columns = object.fields.filter((f) => !f.isSystem);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['records', object.name] });

  if (records.isLoading) return <Spinner />;
  const rows = records.data?.data ?? [];
  const pagination = records.data?.pagination;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{pagination?.totalCount ?? 0} records</p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Add record
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No records yet" hint="Add your first record to get started." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                {columns.map((c) => (
                  <th key={c.name} className="whitespace-nowrap px-3 py-2 font-medium">
                    {c.displayName}
                  </th>
                ))}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = String(row.id);
                return (
                  <tr key={id} className="border-t border-border/60 hover:bg-muted/30">
                    {columns.map((c) => (
                      <td key={c.name} className="max-w-xs truncate px-3 py-2">
                        {renderCell(row[c.columnName])}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Edit"
                        onClick={() => setEditing(row)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Delete"
                        onClick={() => {
                          if (confirm('Delete this record?')) del.mutate(id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={!pagination.hasPreviousPage}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!pagination.hasNextPage}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {(creating || editing) && (
        <RecordForm
          object={object}
          record={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function renderCell(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function RecordForm({
  object,
  record,
  onClose,
  onSaved,
}: {
  object: DataObjectDefinition;
  record: Record<string, unknown> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editable = object.fields.filter((f) => !f.isSystem && !f.isPrimary);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of editable) {
      const v = record?.[f.columnName];
      initial[f.name] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return initial;
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = buildPayload(editable, values);
      if (record?.id) return api.updateRecord(object.name, String(record.id), payload);
      return api.createRecord(object.name, payload);
    },
    onSuccess: onSaved,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={record ? `Edit ${object.displayName}` : `New ${object.displayName}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {editable.map((f) => (
          <div key={f.name} className="flex flex-col gap-1.5">
            <Label>
              {f.displayName}
              {f.isRequired && <span className="ml-1 text-destructive">*</span>}
              <span className="ml-2 font-normal text-xs text-muted-foreground">{f.columnType}</span>
            </Label>
            <FieldInput
              field={f}
              value={values[f.name] ?? ''}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
            />
          </div>
        ))}
        {save.error && (
          <p className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : 'Failed to save record'}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.columnType === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(String(e.target.checked))}
        />
        {value === 'true' ? 'True' : 'False'}
      </label>
    );
  }
  if (
    field.columnType === 'json' ||
    field.columnType === 'long_text' ||
    field.columnType === 'rich_text'
  ) {
    return <Textarea value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  const numeric = [
    'integer',
    'big_integer',
    'decimal',
    'float',
    'currency',
    'percentage',
    'rating',
  ].includes(field.columnType);
  return (
    <Input
      type={numeric ? 'number' : field.columnType === 'datetime' ? 'datetime-local' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Coerces string form values into typed values for the API. */
function buildPayload(
  fields: FieldDefinition[],
  values: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.name];
    if (raw === undefined || raw === '') continue;
    if (f.columnType === 'boolean') {
      payload[f.name] = raw === 'true';
    } else if (['integer', 'big_integer', 'rating'].includes(f.columnType)) {
      payload[f.name] = Number.parseInt(raw, 10);
    } else if (['decimal', 'float', 'currency', 'percentage'].includes(f.columnType)) {
      payload[f.name] = Number.parseFloat(raw);
    } else if (f.columnType === 'json') {
      try {
        payload[f.name] = JSON.parse(raw);
      } catch {
        payload[f.name] = raw;
      }
    } else {
      payload[f.name] = raw;
    }
  }
  return payload;
}
