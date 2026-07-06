/**
 * RecordChip + RecordPeek — linked-record display (Phase 10 / Tier 3B).
 *
 * A RecordChip renders a foreign-key value as the target record's display
 * value (the target's first non-system text field, or the link field's
 * `uiOptions.displayField` override) in a small rounded chip. Clicking it
 * opens a **RecordPeek**: a read-only side panel of the target record,
 * Supabase-style, with a jump-to-object action.
 *
 * Lookups are cached per (object, id) via react-query, so a grid column of
 * chips issues at most one fetch per distinct linked record.
 */

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, Link2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import type { DataObjectDefinition } from '../../lib/types';
import { Badge, Button, Sheet, Skeleton } from '../ui';
import { editValueOf } from './grid-cell-editor';

// --- Display-value resolution --------------------------------------------

/** The field whose value labels a record of this object. */
export function displayFieldOf(
  target: DataObjectDefinition | undefined,
  override?: string,
): string {
  if (override) return override;
  const firstText = target?.fields.find(
    (f) => !f.isSystem && !f.isPrimary && ['text', 'enum'].includes(categoryOf(f.columnType)),
  );
  return firstText?.columnName ?? 'id';
}

function categoryOf(columnType: string): string {
  if (
    ['text', 'short_text', 'long_text', 'rich_text', 'email', 'url', 'phone', 'slug'].includes(
      columnType,
    )
  ) {
    return 'text';
  }
  if (columnType === 'enum') return 'enum';
  return columnType;
}

/** Human label for a linked record row (falls back to a truncated id). */
export function recordLabelOf(
  record: Record<string, unknown> | undefined,
  displayField: string,
): string {
  const value = record?.[displayField];
  if (value !== null && value !== undefined && value !== '') return String(value);
  const id = record?.id;
  return id ? `${String(id).slice(0, 8)}…` : '—';
}

// --- Components ----------------------------------------------------------

export interface RecordChipProps {
  /** Target object name the FK points at. */
  targetObject: string;
  /** The FK value (record id). */
  id: unknown;
  /** Display-field override (`uiOptions.displayField` on the link field). */
  displayField?: string;
}

export function RecordChip({ targetObject, id, displayField }: RecordChipProps) {
  const [peek, setPeek] = useState(false);

  const target = useQuery({
    queryKey: ['object', targetObject],
    queryFn: () => api.getObject(targetObject),
    staleTime: 60_000,
  });
  const record = useQuery({
    queryKey: ['record-chip', targetObject, String(id)],
    queryFn: () => api.getRecord(targetObject, String(id)),
    enabled: id != null,
    staleTime: 30_000,
  });

  if (id == null) return <span className="text-muted-foreground/50">—</span>;

  const field = displayFieldOf(target.data, displayField);
  const label = record.isLoading ? '…' : recordLabelOf(record.data, field);

  return (
    <>
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-ion-purple/30 bg-ion-purple/10 px-2 py-0.5 text-xs text-foreground hover:bg-ion-purple/20"
        onClick={(e) => {
          e.stopPropagation();
          setPeek(true);
        }}
        aria-label={`Peek linked ${targetObject} record`}
      >
        <Link2 className="h-3 w-3 shrink-0 text-ion-purple" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      {peek && (
        <RecordPeek targetObject={targetObject} id={String(id)} onClose={() => setPeek(false)} />
      )}
    </>
  );
}
RecordChip.displayName = 'RecordChip';

/** Read-only side panel showing a linked record's fields. */
export function RecordPeek({
  targetObject,
  id,
  onClose,
}: {
  targetObject: string;
  id: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const target = useQuery({
    queryKey: ['object', targetObject],
    queryFn: () => api.getObject(targetObject),
  });
  const record = useQuery({
    queryKey: ['record-chip', targetObject, id],
    queryFn: () => api.getRecord(targetObject, id),
  });

  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          {target.data?.displayName ?? targetObject}
          <Badge variant="outline" className="font-mono text-[10px]">
            linked record
          </Badge>
        </span>
      }
      description={<span className="font-mono text-xs">{id}</span>}
      footer={
        <Button
          variant="outline"
          className="ml-auto gap-1.5"
          onClick={() => {
            onClose();
            void navigate({ to: '/objects/$name', params: { name: targetObject } });
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open {targetObject}
        </Button>
      }
    >
      {(target.isLoading || record.isLoading) && <Skeleton className="h-40 w-full" />}
      {target.data && record.data && (
        <dl className="flex flex-col gap-2.5">
          {target.data.fields
            .filter((f) => !f.isSystem)
            .map((f) => (
              <div key={f.name} className="grid grid-cols-[40%_60%] gap-2 text-sm">
                <dt className="text-muted-foreground">{f.displayName}</dt>
                <dd className="truncate">{editValueOf(record.data?.[f.columnName]) || '—'}</dd>
              </div>
            ))}
        </dl>
      )}
    </Sheet>
  );
}
RecordPeek.displayName = 'RecordPeek';
