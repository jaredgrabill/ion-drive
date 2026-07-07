/**
 * M2MLinkEditor — junction editing for one many_to_many relationship of a
 * record (Phase 13). Lives in the RecordSheet's "Linked records" section.
 *
 * Reads the current links via `getRecord(..., expand=<rel>)`, renders them
 * as removable chips, and adds new ones through the RecordPicker (whose
 * selection calls the link API rather than setting a FK value). Writes go
 * through `POST/DELETE /data/:object/:id/links/:rel` — idempotent junction
 * upserts/deletes that emit `data.<object>.linked|unlinked` events.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { ApiError, api } from '../../lib/api';
import { displayFieldOf, recordLabelOf } from '../../lib/record-label';
import type { DataObjectDefinition, RelationshipDefinition } from '../../lib/types';
import { Skeleton, toast } from '../ui';
import { linkTargetOf } from './grid-types';
import { RecordPicker } from './record-picker';

export interface M2MLinkEditorProps {
  object: DataObjectDefinition;
  rel: RelationshipDefinition;
  recordId: string;
}

export function M2MLinkEditor({ object, rel, recordId }: M2MLinkEditorProps) {
  const queryClient = useQueryClient();
  const targetObject = linkTargetOf(object, rel);

  const linksKey = ['record-links', object.name, recordId, rel.name];
  const links = useQuery({
    queryKey: linksKey,
    queryFn: () => api.getRecord(object.name, recordId, rel.name),
  });
  const target = useQuery({
    queryKey: ['object', targetObject],
    queryFn: () => api.getObject(targetObject),
    staleTime: 60_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: linksKey });
    void queryClient.invalidateQueries({ queryKey: ['records', object.name] });
  };
  const onError = (error: unknown) =>
    toast.error(
      `Failed to update links: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
    );

  const add = useMutation({
    mutationFn: (targetId: string) => api.addLinks(object.name, recordId, rel.name, [targetId]),
    onSuccess: (result) => {
      if (result.added === 0) toast('Already linked');
      invalidate();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (targetId: string) => api.removeLinks(object.name, recordId, rel.name, [targetId]),
    onSuccess: invalidate,
    onError,
  });

  const linked = Array.isArray(links.data?.[rel.name])
    ? (links.data?.[rel.name] as Record<string, unknown>[])
    : [];
  const displayField = displayFieldOf(target.data);

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">
        {rel.displayName}
        <span className="ml-2 font-mono text-[10px] text-muted-foreground">{targetObject}</span>
      </p>
      {links.isLoading ? (
        <Skeleton className="h-7 w-full" />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {linked.map((record) => {
            const id = String(record.id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-ion-purple/30 bg-ion-purple/10 py-0.5 pr-1 pl-2.5 text-xs"
              >
                <span className="max-w-[160px] truncate">
                  {recordLabelOf(record, displayField)}
                </span>
                <button
                  type="button"
                  aria-label={`Unlink ${recordLabelOf(record, displayField)}`}
                  className="rounded-full p-0.5 hover:bg-ion-purple/20"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(id)}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            );
          })}
          {linked.length === 0 && (
            <span className="text-xs text-muted-foreground">No linked records</span>
          )}
        </div>
      )}
      <RecordPicker
        targetObject={targetObject}
        value=""
        placeholder={`Link a ${target.data?.displayName ?? targetObject} record…`}
        onChange={(id) => {
          if (id) add.mutate(id);
        }}
        aria-label={`Add ${rel.displayName} link`}
      />
    </div>
  );
}
M2MLinkEditor.displayName = 'M2MLinkEditor';
