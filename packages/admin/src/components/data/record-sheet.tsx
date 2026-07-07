/**
 * RecordSheet — CRM-style slide-out editor for a single record.
 *
 * Opens from the right (Sheet primitive) when a grid row is expanded or a
 * new record is created. Fields render as label + type-aware editor rows
 * (the same GridCellEditor family as inline editing, at full width). Form
 * state runs through react-hook-form with a zod schema derived from the
 * object's field definitions (required flags, email/url/number/JSON
 * validity). System fields (`id`, `created_at`, `updated_at`) show read-only
 * at the bottom; relationships list as links to their target objects.
 * Footer: Delete (with AlertDialog confirm) on the left, Cancel/Save right.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Copy, Link2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, api } from '../../lib/api';
import type { DataObjectDefinition, FieldDefinition } from '../../lib/types';
import { AlertDialog, Badge, Button, Label, Separator, Sheet, toast } from '../ui';
import { GridCellEditor, coerceValue, editValueOf } from './grid-cell-editor';
import {
  type CellKind,
  NUMERIC_KINDS,
  cellKindOf,
  linkTargetOf,
  linkedRelationshipOf,
  m2mRelationshipsOf,
} from './grid-types';
import { M2MLinkEditor } from './m2m-link-editor';
import { RecordPicker } from './record-picker';

// --- Schema derivation --------------------------------------------------

type Constraints = NonNullable<FieldDefinition['constraints']>;

/** Adds numeric min/max issues (value bounds) for a number-kind field. */
function addNumericConstraintIssues(value: string, ctx: z.RefinementCtx, c: Constraints): void {
  const n = Number(value);
  if (c.min !== undefined && n < c.min) {
    ctx.addIssue({ code: 'custom', message: `Must be at least ${c.min}` });
  }
  if (c.max !== undefined && n > c.max) {
    ctx.addIssue({ code: 'custom', message: `Must be at most ${c.max}` });
  }
}

/** Adds text issues: length bounds, pattern match, and enum membership. */
function addTextConstraintIssues(
  value: string,
  ctx: z.RefinementCtx,
  c: Constraints,
  kind: CellKind,
): void {
  if (c.min !== undefined && value.length < c.min) {
    ctx.addIssue({ code: 'custom', message: `At least ${c.min} characters` });
  }
  if (c.max !== undefined && value.length > c.max) {
    ctx.addIssue({ code: 'custom', message: `At most ${c.max} characters` });
  }
  if (c.pattern) {
    try {
      if (!new RegExp(c.pattern).test(value)) {
        ctx.addIssue({ code: 'custom', message: c.message ?? `Must match ${c.pattern}` });
      }
    } catch {
      // POSIX-only regex — the server (and Postgres) remain the judge.
    }
  }
  if (kind === 'enum' && c.enumValues?.length && value !== '') {
    if (!c.enumValues.includes(value)) {
      ctx.addIssue({ code: 'custom', message: `Must be one of: ${c.enumValues.join(', ')}` });
    }
  }
}

/** Builds a per-field string validator from the field definition. */
function fieldSchema(field: FieldDefinition, kind: CellKind): z.ZodTypeAny {
  let schema = z.string();
  if (field.isRequired) schema = schema.min(1, `${field.displayName} is required`);
  const optionalOk = (value: string) => !field.isRequired && value === '';

  // Field constraints (Phase 10) — mirror the CHECK constraints so the form
  // catches violations before the API's friendly 400 would.
  const constraints = field.constraints;
  if (constraints) {
    const numeric = NUMERIC_KINDS.has(kind);
    schema = schema.superRefine((value, ctx) => {
      if (optionalOk(value)) return;
      if (numeric && value !== '') {
        addNumericConstraintIssues(value, ctx, constraints);
        return;
      }
      addTextConstraintIssues(value, ctx, constraints, kind);
    }) as unknown as z.ZodString;
  }

  if (kind === 'email') {
    return schema.refine((v) => optionalOk(v) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'Invalid email address',
    });
  }
  if (kind === 'url') {
    return schema.refine(
      (v) => {
        if (optionalOk(v)) return true;
        try {
          new URL(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Invalid URL' },
    );
  }
  if (NUMERIC_KINDS.has(kind)) {
    return schema.refine((v) => optionalOk(v) || Number.isFinite(Number(v)), {
      message: 'Must be a number',
    });
  }
  if (kind === 'json') {
    return schema.refine(
      (v) => {
        if (optionalOk(v)) return true;
        try {
          JSON.parse(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Invalid JSON' },
    );
  }
  return schema;
}

// --- Component -----------------------------------------------------------

export interface RecordSheetProps {
  object: DataObjectDefinition;
  /** The record to edit, or null for create mode. */
  record: Record<string, unknown> | null;
  onClose: () => void;
  onSaved: () => void;
}

export function RecordSheet({ object, record, onClose, onSaved }: RecordSheetProps) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editable = object.fields.filter((f) => !f.isSystem && !f.isPrimary);
  const systemFields = object.fields.filter((f) => f.isSystem || f.isPrimary);
  const relationships = object.relationships ?? [];

  // First two text fields double as the record's display title/subtitle.
  const titleField = editable.find((f) => cellKindOf(f.columnType) === 'text');

  const schema = z.object(
    Object.fromEntries(editable.map((f) => [f.name, fieldSchema(f, cellKindOf(f.columnType))])),
  );
  type FormValues = Record<string, string>;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: Object.fromEntries(
      editable.map((f) => [f.name, editValueOf(record?.[f.columnName])]),
    ),
  });

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: Record<string, unknown> = {};
      for (const field of editable) {
        const raw = values[field.name] ?? '';
        // In create mode, omit untouched empty fields so column defaults apply.
        if (!record && raw === '') continue;
        payload[field.name] = coerceValue(cellKindOf(field.columnType), raw);
      }
      return record?.id
        ? api.updateRecord(object.name, String(record.id), payload)
        : api.createRecord(object.name, payload);
    },
    onSuccess: () => {
      toast.success(record ? 'Record updated' : 'Record created');
      onSaved();
    },
    onError: (error) =>
      toast.error(
        `Failed to save: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteRecord(object.name, String(record?.id)),
    onSuccess: () => {
      toast.success('Record deleted');
      onSaved();
    },
    onError: (error) =>
      toast.error(
        `Failed to delete: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const titleValue = form.watch(titleField?.name ?? '');

  return (
    <Sheet
      open
      onClose={onClose}
      title={record ? object.displayName : `New ${object.displayName}`}
      description={
        record?.id ? (
          <span className="inline-flex items-center gap-1 font-mono text-xs">
            {String(record.id)}
            <button
              type="button"
              aria-label="Copy record id"
              onClick={() => {
                navigator.clipboard?.writeText(String(record.id));
                toast('Copied record id');
              }}
            >
              <Copy className="h-3 w-3" />
            </button>
          </span>
        ) : undefined
      }
      footer={
        <>
          {record && (
            <Button
              variant="ghost"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={form.handleSubmit((values) => save.mutate(values))}
              disabled={save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </>
      }
    >
      {/* Title area — the first text field rendered large */}
      {titleField && titleValue && (
        <p className="mb-4 truncate text-xl font-semibold tracking-tight">{titleValue}</p>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((values) => save.mutate(values))}
      >
        {editable.map((field) => {
          const error = form.formState.errors[field.name];
          return (
            <div key={field.name} className="grid grid-cols-[40%_60%] items-start gap-2">
              <Label htmlFor={`rs-${field.name}`} className="pt-2 text-muted-foreground">
                {field.displayName}
                {field.isRequired && <span className="ml-0.5 text-destructive">*</span>}
              </Label>
              <div className="flex flex-col gap-1">
                <Controller
                  control={form.control}
                  name={field.name}
                  render={({ field: rhf }) => {
                    const linkRel = linkedRelationshipOf(object, field);
                    if (linkRel) {
                      return (
                        <RecordPicker
                          targetObject={linkTargetOf(object, linkRel)}
                          value={rhf.value ?? ''}
                          displayField={field.uiOptions?.displayField as string | undefined}
                          onChange={rhf.onChange}
                          aria-label={`Link ${field.displayName}`}
                        />
                      );
                    }
                    return (
                      <GridCellEditor
                        field={field}
                        value={rhf.value ?? ''}
                        onChange={rhf.onChange}
                        fullWidth
                      />
                    );
                  }}
                />
                {error && <p className="text-xs text-destructive">{String(error.message)}</p>}
              </div>
            </div>
          );
        })}
      </form>

      {/* Linked records — junction editing per many_to_many rel (Phase 13) */}
      {record?.id != null && m2mRelationshipsOf(object).length > 0 && (
        <>
          <Separator className="my-4" />
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
            Linked records
          </p>
          <div className="flex flex-col gap-4">
            {m2mRelationshipsOf(object).map((rel) => (
              <M2MLinkEditor
                key={rel.name}
                object={object}
                rel={rel}
                recordId={String(record.id)}
              />
            ))}
          </div>
        </>
      )}

      {/* Relationships */}
      {relationships.length > 0 && (
        <>
          <Separator className="my-4" />
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
            Relationships
          </p>
          <div className="flex flex-col gap-1">
            {relationships.map((rel) => {
              const target =
                rel.targetObjectName === object.name ? rel.sourceObjectName : rel.targetObjectName;
              return (
                <button
                  key={rel.name}
                  type="button"
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => void navigate({ to: '/objects/$name', params: { name: target } })}
                >
                  <Link2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  <span className="font-medium">{rel.displayName}</span>
                  <Badge variant="outline">{rel.type.replace(/_/g, ' ')}</Badge>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{target}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* System fields */}
      {record && systemFields.length > 0 && (
        <>
          <Separator className="my-4" />
          <div className="flex flex-col gap-1.5">
            {systemFields.map((field) => (
              <div key={field.name} className="grid grid-cols-[40%_60%] gap-2 text-xs">
                <span className="text-muted-foreground">{field.displayName}</span>
                <span className="truncate font-mono text-muted-foreground">
                  {editValueOf(record[field.columnName]) || '—'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <AlertDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete record"
        description="This will permanently delete this record. This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => remove.mutate()}
      />
    </Sheet>
  );
}
RecordSheet.displayName = 'RecordSheet';
