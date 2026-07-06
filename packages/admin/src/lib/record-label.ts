/**
 * Record display-label helpers — how a record is named in the UI.
 *
 * A record's human label is the value of its object's "display field": the
 * link field's `uiOptions.displayField` override when set, otherwise the
 * first non-system text-like field, falling back to the id. Shared by
 * RecordChip/RecordPicker (linked-record cells) and the command palette's
 * global record search — kept in `lib/` so the palette (initial bundle)
 * doesn't need to import grid components.
 */

import type { DataObjectDefinition } from './types';

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

/** Human label for a record row (falls back to a truncated id). */
export function recordLabelOf(
  record: Record<string, unknown> | undefined,
  displayField: string,
): string {
  const value = record?.[displayField];
  if (value !== null && value !== undefined && value !== '') return String(value);
  const id = record?.id;
  return id ? `${String(id).slice(0, 8)}…` : '—';
}
