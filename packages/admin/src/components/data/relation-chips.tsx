/**
 * RelationChipList — read-only chips for a many_to_many cell (Phase 13).
 *
 * The grid's m2m columns are expand-fed: the list query carries
 * `expand=<rel>` and each row arrives with `row[rel] = Record[]`. This
 * renders the first few related records as labeled chips plus a `+n`
 * overflow badge; labels resolve through the target object's display field
 * (same rules as RecordChip). Editing happens in the RecordSheet's linked
 * records section, not inline.
 */

import { useQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { api } from '../../lib/api';
import { displayFieldOf, recordLabelOf } from '../../lib/record-label';

const MAX_CHIPS = 3;

export interface RelationChipListProps {
  /** The object the related records belong to. */
  targetObject: string;
  /** The expanded related records (`row[rel]`), if the expand ran. */
  records: unknown;
}

export function RelationChipList({ targetObject, records }: RelationChipListProps) {
  const target = useQuery({
    queryKey: ['object', targetObject],
    queryFn: () => api.getObject(targetObject),
    staleTime: 60_000,
  });

  const list = Array.isArray(records) ? (records as Record<string, unknown>[]) : [];
  if (list.length === 0) {
    return <span className="text-muted-foreground/60">—</span>;
  }

  const field = displayFieldOf(target.data);
  const shown = list.slice(0, MAX_CHIPS);
  const overflow = list.length - shown.length;

  return (
    <span className="flex items-center gap-1 overflow-hidden">
      {shown.map((record) => (
        <span
          key={String(record.id)}
          className="inline-flex max-w-[120px] items-center gap-1 rounded-full border border-ion-purple/30 bg-ion-purple/10 px-2 py-0.5 text-xs"
        >
          <Link2 className="h-2.5 w-2.5 shrink-0 text-ion-purple" aria-hidden />
          <span className="truncate">{recordLabelOf(record, field)}</span>
        </span>
      ))}
      {overflow > 0 && (
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          +{overflow}
        </span>
      )}
    </span>
  );
}
RelationChipList.displayName = 'RelationChipList';
