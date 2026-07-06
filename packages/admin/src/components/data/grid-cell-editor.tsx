/**
 * GridCellEditor — type-aware value editor, shared by the grid's inline edit
 * mode and the RecordSheet's field rows.
 *
 * Renders the appropriate control for a cell kind: text/number/email/url
 * inputs (auto-select-all on focus for inline editing), a native date/
 * datetime picker, a Select for enums, a Checkbox for booleans, click-to-set
 * stars for ratings, and a monospace Textarea for long text / JSON. Values
 * are edited as strings and coerced by `coerceValue` on save.
 *
 * Keyboard contract (wired by the parent): Enter commits, Escape cancels,
 * Tab commits and moves on.
 */

import { type KeyboardEvent, useEffect, useRef } from 'react';
import type { FieldDefinition } from '../../lib/types';
import { Checkbox, Input, Select, Textarea } from '../ui';
import { type CellKind, NUMERIC_KINDS, cellKindOf } from './grid-types';

// --- Types -----------------------------------------------------------

export interface GridCellEditorProps {
  field: FieldDefinition;
  /** Current editing value, always a string ('' = empty). */
  value: string;
  onChange: (value: string) => void;
  /** Commit the edit (Enter, or control-specific confirm). */
  onCommit?: () => void;
  /** Cancel the edit (Escape). */
  onCancel?: () => void;
  /** Autofocus + select-all (inline grid editing). */
  autoFocus?: boolean;
  /** Render at full form width (RecordSheet) instead of cell-constrained. */
  fullWidth?: boolean;
}

// --- Value coercion ----------------------------------------------------

/** Coerces an edited string back into the API's typed value. */
export function coerceValue(kind: CellKind, raw: string): unknown {
  if (raw === '') return null;
  if (kind === 'boolean') return raw === 'true';
  if (NUMERIC_KINDS.has(kind)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (kind === 'json') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Converts a stored value into its editing string. */
export function editValueOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

// --- Component -------------------------------------------------------

export function GridCellEditor({
  field,
  value,
  onChange,
  onCommit,
  onCancel,
  autoFocus = false,
  fullWidth = false,
}: GridCellEditorProps) {
  const kind = cellKindOf(field.columnType);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && kind !== 'longText' && kind !== 'json') {
      e.preventDefault();
      onCommit?.();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
    }
  };

  switch (kind) {
    case 'boolean':
      return (
        <Checkbox
          checked={value === 'true'}
          onCheckedChange={(checked) => onChange(String(checked === true))}
          aria-label={field.displayName}
        />
      );

    case 'rating':
      return (
        <div className="flex gap-0.5" aria-label={field.displayName}>
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              aria-pressed={Number(value) >= star}
              aria-label={`${star} stars`}
              className="text-lg leading-none transition-transform hover:scale-110"
              onClick={() => onChange(String(star))}
            >
              <span
                className={star <= Number(value) ? 'text-ion-amber' : 'text-muted-foreground/40'}
              >
                ★
              </span>
            </button>
          ))}
        </div>
      );

    case 'enum': {
      // Choice values come from the field's constraints (Phase 10 — the same
      // list the CHECK constraint enforces). Free-text fallback without them.
      const enumValues = field.constraints?.enumValues;
      if (enumValues?.length) {
        return <EnumEditor field={field} value={value} values={enumValues} onChange={onChange} />;
      }
      return (
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-8"
          aria-label={field.displayName}
        />
      );
    }

    case 'longText':
    case 'json':
      return (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={fullWidth ? 6 : 4}
          className={kind === 'json' ? 'font-mono text-xs' : undefined}
          aria-label={field.displayName}
        />
      );

    case 'date':
    case 'datetime':
      return (
        <Input
          ref={inputRef}
          type={kind === 'date' ? 'date' : 'datetime-local'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-8"
          aria-label={field.displayName}
        />
      );

    case 'uuid':
      return <span className="font-mono text-xs text-muted-foreground">{value || '—'}</span>;

    default: {
      // Constraint hints (Phase 10): numbers get min/max, text gets maxLength.
      const numeric = NUMERIC_KINDS.has(kind);
      const constraints = field.constraints ?? undefined;
      return (
        <Input
          ref={inputRef}
          type={numeric ? 'number' : kind === 'email' ? 'email' : kind === 'url' ? 'url' : 'text'}
          min={numeric ? constraints?.min : undefined}
          max={numeric ? constraints?.max : undefined}
          maxLength={!numeric ? constraints?.max : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-8"
          aria-label={field.displayName}
        />
      );
    }
  }
}
GridCellEditor.displayName = 'GridCellEditor';

// --- Select-based enum editor (used when values are known) -------------

export interface EnumEditorProps {
  field: FieldDefinition;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}

/** Enum editor with a known value set (falls back to GridCellEditor otherwise). */
export function EnumEditor({ field, value, values, onChange }: EnumEditorProps) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={field.displayName}
      className="h-8"
    >
      <option value="">—</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </Select>
  );
}
EnumEditor.displayName = 'EnumEditor';
