/**
 * FieldEditorSheet — one sheet for adding **and** editing a field
 * (Phase 10 / 2B; replaces the thin Add Field dialog).
 *
 * Add mode: identifier + display name (decoupled after first manual edit),
 * description, grouped type picker (incl. the "Link to record" pseudo-type,
 * Tier 3A — which creates a FK + relationship instead of a plain column),
 * a type-aware default-value input, constraint inputs appropriate to the
 * type (value/length bounds, pattern + custom message), an enum choices
 * editor (reorder + per-choice color stored in `uiOptions.choiceColors`),
 * and required/unique/indexed toggles.
 *
 * Edit mode: the same form pre-filled; **Save runs a dry-run preview first**
 * (`PATCH ?dryRun=true`) and shows the exact SQL + warnings for an explicit
 * confirm. Errors surface inline — a NULL-blocked required toggle asks for a
 * backfill value; block-managed fields disable structural inputs until the
 * "override protection" switch is armed (mirrors install-force semantics).
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical, Plus, ShieldAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import type {
  ChangePreview,
  ColumnType,
  DataObjectDefinition,
  FieldConstraints,
  FieldDefinition,
  FieldModification,
} from '../../lib/types';
import { cn } from '../../lib/utils';
import { GridCellEditor } from '../data/grid-cell-editor';
import { Badge, Button, Input, Label, Select, Sheet, Switch, Textarea, toast } from '../ui';
import { FieldTypePicker, LINK_TYPE } from './field-type-picker';

// --- Helpers ----------------------------------------------------------

const NUMERIC_TYPES = new Set([
  'integer',
  'big_integer',
  'decimal',
  'float',
  'percentage',
  'currency',
  'rating',
]);
const TEXT_LIKE = new Set([
  'text',
  'short_text',
  'long_text',
  'rich_text',
  'email',
  'url',
  'phone',
  'slug',
  'enum',
  'color',
]);
const ENUM_TYPES = new Set(['enum', 'multi_enum']);

/** Owning block name when the field is block-managed, else null. */
function blockOwnerOf(field: FieldDefinition | null): string | null {
  const managedBy = field?.managedBy;
  return managedBy?.startsWith('block:') ? managedBy.slice('block:'.length) : null;
}

function titleCaseOf(identifier: string): string {
  return identifier
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface EnumChoice {
  value: string;
  color: string;
}

const CHOICE_COLORS = ['#5b8def', '#8b5cf6', '#22d3ee', '#34d399', '#fbbf24', '#fb7185'];

// --- Component --------------------------------------------------------

export interface FieldEditorSheetProps {
  object: DataObjectDefinition;
  /** Field to edit, or null for add mode. */
  field: FieldDefinition | null;
  columnTypes: ColumnType[];
  onClose: () => void;
  onSaved: () => void;
}

export function FieldEditorSheet({
  object,
  field,
  columnTypes,
  onClose,
  onSaved,
}: FieldEditorSheetProps) {
  const isEdit = field !== null;
  const blockOwner = blockOwnerOf(field);

  // --- Form state ---
  const [name, setName] = useState(field?.name ?? '');
  const [displayName, setDisplayName] = useState(field?.displayName ?? '');
  const [displayNameTouched, setDisplayNameTouched] = useState(isEdit);
  const [description, setDescription] = useState(field?.description ?? '');
  const [columnType, setColumnType] = useState(field?.columnType ?? 'text');
  const [defaultValue, setDefaultValue] = useState(field?.defaultValue ?? '');
  const [isRequired, setIsRequired] = useState(field?.isRequired ?? false);
  const [isUnique, setIsUnique] = useState(field?.isUnique ?? false);
  const [isIndexed, setIsIndexed] = useState(field?.isIndexed ?? false);
  const [min, setMin] = useState(field?.constraints?.min?.toString() ?? '');
  const [max, setMax] = useState(field?.constraints?.max?.toString() ?? '');
  const [pattern, setPattern] = useState(field?.constraints?.pattern ?? '');
  const [message, setMessage] = useState(field?.constraints?.message ?? '');
  const [choices, setChoices] = useState<EnumChoice[]>(() => {
    const colors = (field?.uiOptions?.choiceColors ?? {}) as Record<string, string>;
    return (field?.constraints?.enumValues ?? []).map((value, i) => ({
      value,
      color: colors[value] ?? CHOICE_COLORS[i % CHOICE_COLORS.length] ?? '#5b8def',
    }));
  });
  // Link-to-record state (add mode, Tier 3A)
  const [linkTarget, setLinkTarget] = useState('');
  const [linkMultiple, setLinkMultiple] = useState(false);
  // Edit-mode extras
  const [force, setForce] = useState(false);
  const [backfillValue, setBackfillValue] = useState('');
  const [preview, setPreview] = useState<ChangePreview | null>(null);

  const objects = useQuery({
    queryKey: ['objects'],
    queryFn: () => api.listObjects(),
    enabled: !isEdit,
  });

  const isLink = columnType === LINK_TYPE;
  const numeric = NUMERIC_TYPES.has(columnType);
  const textLike = TEXT_LIKE.has(columnType);
  const isEnum = ENUM_TYPES.has(columnType);
  const structuralLocked = blockOwner !== null && !force;

  // --- Assemble the constraint object from the inputs ---
  const constraints = useMemo((): FieldConstraints | undefined => {
    const c: FieldConstraints = {};
    if (min !== '' && Number.isFinite(Number(min))) c.min = Number(min);
    if (max !== '' && Number.isFinite(Number(max))) c.max = Number(max);
    if (pattern.trim()) c.pattern = pattern.trim();
    if (message.trim()) c.message = message.trim();
    if (isEnum) {
      const values = choices.map((ch) => ch.value.trim()).filter(Boolean);
      if (values.length > 0) c.enumValues = values;
    }
    return Object.keys(c).length > 0 ? c : undefined;
  }, [min, max, pattern, message, isEnum, choices]);

  const uiOptions = useMemo((): Record<string, unknown> | undefined => {
    if (!isEnum) return field?.uiOptions ?? undefined;
    const choiceColors = Object.fromEntries(
      choices.filter((ch) => ch.value.trim()).map((ch) => [ch.value.trim(), ch.color]),
    );
    return { ...(field?.uiOptions ?? {}), choiceColors };
  }, [isEnum, choices, field?.uiOptions]);

  // --- Compute the modification diff (edit mode) ---
  const updates = useMemo((): FieldModification => {
    if (!field) return {};
    const u: FieldModification = {};
    if (name !== field.name) u.name = name;
    if (displayName !== field.displayName) u.displayName = displayName;
    if ((description || null) !== (field.description ?? null)) {
      u.description = description || null;
    }
    if (columnType !== field.columnType) u.columnType = columnType;
    if (isRequired !== (field.isRequired ?? false)) u.isRequired = isRequired;
    if (isUnique !== (field.isUnique ?? false)) u.isUnique = isUnique;
    if (isIndexed !== (field.isIndexed ?? false)) u.isIndexed = isIndexed;
    if ((defaultValue || null) !== (field.defaultValue ?? null)) {
      u.defaultValue = defaultValue || null;
    }
    if (JSON.stringify(constraints ?? null) !== JSON.stringify(field.constraints ?? null)) {
      u.constraints = constraints ?? null;
    }
    if (JSON.stringify(uiOptions ?? null) !== JSON.stringify(field.uiOptions ?? null)) {
      u.uiOptions = uiOptions ?? null;
    }
    if (backfillValue) u.backfillValue = backfillValue;
    return u;
  }, [
    field,
    name,
    displayName,
    description,
    columnType,
    isRequired,
    isUnique,
    isIndexed,
    defaultValue,
    constraints,
    uiOptions,
    backfillValue,
  ]);

  const hasChanges = Object.keys(updates).some((k) => k !== 'backfillValue');

  // --- Mutations ---
  const runPreview = useMutation({
    mutationFn: () => api.previewFieldChange(object.name, field?.name ?? '', updates),
    onSuccess: (result) => setPreview(result),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Preview failed unexpectedly'),
  });

  const applyEdit = useMutation({
    mutationFn: () => api.modifyField(object.name, field?.name ?? '', updates, { force }),
    onSuccess: () => {
      toast.success(`Updated ${displayName || name}`);
      onSaved();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Save failed unexpectedly'),
  });

  const addField = useMutation({
    mutationFn: () => {
      if (isLink) {
        return api.addRelationship({
          name: name.trim(),
          displayName: displayName.trim() || titleCaseOf(name),
          type: linkMultiple ? 'many_to_many' : 'many_to_one',
          sourceObjectName: object.name,
          targetObjectName: linkTarget,
        });
      }
      return api.addField(object.name, {
        name: name.trim(),
        displayName: displayName.trim() || titleCaseOf(name),
        columnType,
        isRequired,
        isUnique,
        isIndexed,
        defaultValue: defaultValue || undefined,
        description: description || undefined,
        constraints,
        uiOptions,
      });
    },
    onSuccess: () => {
      toast.success(isLink ? `Linked to ${linkTarget}` : `Added ${name}`);
      onSaved();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Save failed unexpectedly'),
  });

  const busy = runPreview.isPending || applyEdit.isPending || addField.isPending;
  const canSubmit = isEdit
    ? hasChanges
    : name.trim().length > 0 && (!isLink || linkTarget.length > 0);

  const needsBackfill = preview?.errors.some((e) => e.code === 'REQUIRES_BACKFILL') ?? false;
  const blockedByBlock = preview?.errors.some((e) => e.code === 'BLOCK_MANAGED_FIELD') ?? false;

  const onPrimary = () => {
    if (!isEdit) {
      addField.mutate();
      return;
    }
    if (preview?.isValid) {
      applyEdit.mutate();
      return;
    }
    runPreview.mutate();
  };

  // Editing anything invalidates a previously computed preview.
  const invalidatePreview = () => setPreview(null);

  const defaultEditorField: FieldDefinition = {
    name: 'default_value',
    displayName: 'Default value',
    columnName: 'default_value',
    columnType: isLink ? 'uuid' : columnType,
    constraints: isEnum && constraints?.enumValues ? { enumValues: constraints.enumValues } : null,
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={isEdit ? `Edit field — ${field.displayName}` : 'Add field'}
      description={
        blockOwner ? (
          <span className="inline-flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 text-ion-amber" aria-hidden />
            Managed by the <Badge variant="secondary">{blockOwner}</Badge> block — structural
            changes are protected.
          </span>
        ) : (
          `on ${object.displayName}`
        )
      }
      className="max-w-[560px]"
      footer={
        <>
          {isEdit && blockOwner && (
            // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Switch (renders a button role=switch)
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={force}
                onCheckedChange={(v) => {
                  setForce(v === true);
                  invalidatePreview();
                }}
                aria-label="Override block protection"
              />
              Override protection
            </label>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={onPrimary} disabled={!canSubmit || busy}>
              {busy
                ? 'Working…'
                : !isEdit
                  ? isLink
                    ? 'Create link'
                    : 'Add field'
                  : preview?.isValid
                    ? 'Apply changes'
                    : 'Review changes'}
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Identifier + display name (decoupled) */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fe-name">Identifier</Label>
            <Input
              id="fe-name"
              value={name}
              disabled={isEdit && structuralLocked}
              onChange={(e) => {
                const next = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
                setName(next);
                if (!displayNameTouched) setDisplayName(titleCaseOf(next));
                invalidatePreview();
              }}
              placeholder="due_date"
              className="font-mono"
            />
            {isEdit && field && name !== field.name && (
              <p className="text-xs text-ion-amber">
                Renaming changes the API name — existing queries using “{field.name}” will break.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fe-display">Display name</Label>
            <Input
              id="fe-display"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setDisplayNameTouched(true);
                invalidatePreview();
              }}
              placeholder="Due Date"
            />
          </div>
        </div>

        {/* Description */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fe-desc">Description</Label>
          <Textarea
            id="fe-desc"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              invalidatePreview();
            }}
            rows={2}
            placeholder="What this field holds — shown in API docs and to agents."
          />
        </div>

        {/* Type */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fe-type">Type</Label>
          <FieldTypePicker
            id="fe-type"
            columnTypes={columnTypes}
            value={columnType}
            includeLink={!isEdit}
            disabled={isEdit && structuralLocked}
            onChange={(next) => {
              setColumnType(next);
              invalidatePreview();
            }}
          />
          {isEdit && field && columnType !== field.columnType && (
            <p className="text-xs text-ion-amber">
              Type changes are validated against existing data before applying.
            </p>
          )}
        </div>

        {/* Link-to-record configuration (Tier 3A) */}
        {isLink && (
          <div className="flex flex-col gap-3 rounded-md border border-ion-purple/30 bg-ion-purple/5 p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fe-link-target">Target object</Label>
              <Select
                id="fe-link-target"
                value={linkTarget}
                onChange={(e) => setLinkTarget(e.target.value)}
              >
                <option value="">Choose…</option>
                {(objects.data ?? [])
                  .filter((o) => !o.isSystem && o.name !== object.name)
                  .map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.displayName}
                    </option>
                  ))}
              </Select>
            </div>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Switch (renders a button role=switch) */}
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={linkMultiple}
                onCheckedChange={(v) => setLinkMultiple(v === true)}
                aria-label="Allow linking multiple records"
              />
              Allow linking to multiple records
            </label>
            <p className="text-xs text-muted-foreground">
              {linkMultiple
                ? 'Creates a many-to-many relationship via a junction table.'
                : `Creates a "${name || 'link'}_id" foreign-key column plus a many-to-one relationship.`}
            </p>
          </div>
        )}

        {/* Default value (not for links) */}
        {!isLink && !isEnum && (
          <div className="flex flex-col gap-1.5">
            <Label>Default value</Label>
            <GridCellEditor
              field={defaultEditorField}
              value={defaultValue ?? ''}
              onChange={(v) => {
                setDefaultValue(v);
                invalidatePreview();
              }}
              fullWidth
            />
            <p className="text-xs text-muted-foreground">
              Literal value or SQL expression (e.g. <code className="font-mono">NOW()</code>).
            </p>
          </div>
        )}

        {/* Enum choices editor */}
        {isEnum && (
          <EnumChoicesEditor
            choices={choices}
            defaultValue={defaultValue ?? ''}
            disabled={structuralLocked}
            onDefaultChange={(v) => {
              setDefaultValue(v);
              invalidatePreview();
            }}
            onChange={(next) => {
              setChoices(next);
              invalidatePreview();
            }}
          />
        )}

        {/* Constraints (bounds + pattern) */}
        {!isLink && (numeric || textLike) && !isEnum && (
          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
              Validation — enforced as CHECK constraints in Postgres
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fe-min">{numeric ? 'Minimum value' : 'Minimum length'}</Label>
                <Input
                  id="fe-min"
                  type="number"
                  value={min}
                  disabled={structuralLocked}
                  onChange={(e) => {
                    setMin(e.target.value);
                    invalidatePreview();
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fe-max">{numeric ? 'Maximum value' : 'Maximum length'}</Label>
                <Input
                  id="fe-max"
                  type="number"
                  value={max}
                  disabled={structuralLocked}
                  onChange={(e) => {
                    setMax(e.target.value);
                    invalidatePreview();
                  }}
                />
              </div>
            </div>
            {textLike && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fe-pattern">Pattern (POSIX regex)</Label>
                <Input
                  id="fe-pattern"
                  value={pattern}
                  disabled={structuralLocked}
                  onChange={(e) => {
                    setPattern(e.target.value);
                    invalidatePreview();
                  }}
                  placeholder="^[A-Z]{2}-\d+$"
                  className="font-mono"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fe-message">Custom validation message</Label>
              <Input
                id="fe-message"
                value={message}
                disabled={structuralLocked}
                onChange={(e) => {
                  setMessage(e.target.value);
                  invalidatePreview();
                }}
                placeholder="Must look like AB-123"
              />
            </div>
          </div>
        )}

        {/* Flags */}
        {!isLink && (
          <div className="flex flex-col gap-2.5 rounded-md border border-border p-3">
            <FlagRow
              label="Required"
              hint="Rejects NULL — existing empty rows need a backfill value."
              checked={isRequired}
              disabled={structuralLocked}
              onChange={(v) => {
                setIsRequired(v);
                invalidatePreview();
              }}
            />
            <FlagRow
              label="Unique"
              hint="No two records may share a value (pre-checked for duplicates)."
              checked={isUnique}
              disabled={structuralLocked}
              onChange={(v) => {
                setIsUnique(v);
                invalidatePreview();
              }}
            />
            <FlagRow
              label="Indexed"
              hint="Adds a database index for faster filtering and sorting."
              checked={isIndexed}
              disabled={false}
              onChange={(v) => {
                setIsIndexed(v);
                invalidatePreview();
              }}
            />
          </div>
        )}

        {/* Backfill input, revealed when the preview demands one */}
        {isEdit && needsBackfill && (
          <div className="flex flex-col gap-1.5 rounded-md border border-ion-amber/40 bg-ion-amber/5 p-3">
            <Label htmlFor="fe-backfill">Backfill value for existing empty rows</Label>
            <Input
              id="fe-backfill"
              value={backfillValue}
              onChange={(e) => {
                setBackfillValue(e.target.value);
                invalidatePreview();
              }}
              placeholder="Value written into rows that are currently empty"
            />
          </div>
        )}

        {/* Change preview (edit mode) */}
        {isEdit && preview && (
          <ChangePreviewPanel preview={preview} blockedByBlock={blockedByBlock} />
        )}
      </div>
    </Sheet>
  );
}
FieldEditorSheet.displayName = 'FieldEditorSheet';

// --- Subcomponents ------------------------------------------------------

function FlagRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Switch (renders a button role=switch)
    <label className={cn('flex items-start gap-3', disabled && 'opacity-60')}>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        aria-label={label}
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
FlagRow.displayName = 'FlagRow';

function EnumChoicesEditor({
  choices,
  defaultValue,
  disabled,
  onChange,
  onDefaultChange,
}: {
  choices: EnumChoice[];
  defaultValue: string;
  disabled: boolean;
  onChange: (choices: EnumChoice[]) => void;
  onDefaultChange: (value: string) => void;
}) {
  const move = (index: number, delta: number) => {
    const next = [...choices];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(index + delta, 0, item);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
        Choices — enforced as a CHECK constraint
      </p>
      {choices.map((choice, index) => (
        <div key={`choice-${index}-${choice.color}`} className="flex items-center gap-1.5">
          <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
          <input
            type="color"
            value={choice.color}
            disabled={disabled}
            aria-label={`Color for ${choice.value || 'choice'}`}
            className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border bg-transparent"
            onChange={(e) =>
              onChange(choices.map((c, i) => (i === index ? { ...c, color: e.target.value } : c)))
            }
          />
          <Input
            value={choice.value}
            disabled={disabled}
            aria-label={`Choice ${index + 1}`}
            className="h-8"
            onChange={(e) =>
              onChange(choices.map((c, i) => (i === index ? { ...c, value: e.target.value } : c)))
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move up"
            disabled={disabled || index === 0}
            onClick={() => move(index, -1)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move down"
            disabled={disabled || index === choices.length - 1}
            onClick={() => move(index, 1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove choice"
            disabled={disabled}
            onClick={() => onChange(choices.filter((_, i) => i !== index))}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        className="gap-1.5 self-start"
        onClick={() =>
          onChange([
            ...choices,
            { value: '', color: CHOICE_COLORS[choices.length % CHOICE_COLORS.length] ?? '#5b8def' },
          ])
        }
      >
        <Plus className="h-3.5 w-3.5" /> Add choice
      </Button>
      {choices.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1">
          <Label htmlFor="fe-enum-default">Default choice</Label>
          <Select
            id="fe-enum-default"
            value={defaultValue}
            onChange={(e) => onDefaultChange(e.target.value)}
          >
            <option value="">No default</option>
            {choices
              .filter((c) => c.value.trim())
              .map((c) => (
                <option key={c.value} value={c.value}>
                  {c.value}
                </option>
              ))}
          </Select>
        </div>
      )}
    </div>
  );
}
EnumChoicesEditor.displayName = 'EnumChoicesEditor';

/** The dry-run result: exact SQL, warnings, and blocking errors. */
function ChangePreviewPanel({
  preview,
  blockedByBlock,
}: {
  preview: ChangePreview;
  blockedByBlock: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3',
        preview.isValid
          ? 'border-ion-green/40 bg-ion-green/5'
          : 'border-destructive/40 bg-destructive/5',
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
        Change preview
      </p>
      {preview.errors.map((error) => (
        <p key={error.code + error.message} className="text-sm text-destructive">
          {error.message}
          {error.code === 'BLOCK_MANAGED_FIELD' && blockedByBlock && (
            <span className="block text-xs text-muted-foreground">
              Arm “Override protection” below to force this change.
            </span>
          )}
        </p>
      ))}
      {preview.warnings.map((warning) => (
        <p
          key={warning.message}
          className={cn('text-sm', warning.severity === 'high' ? 'text-ion-red' : 'text-ion-amber')}
        >
          ▲ {warning.message}
        </p>
      ))}
      {preview.sqlStatements.length > 0 && (
        <pre className="overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs leading-relaxed">
          {preview.sqlStatements.join('\n')}
        </pre>
      )}
      {preview.isValid && (
        <p className="text-xs text-muted-foreground">
          Looks safe — click <strong>Apply changes</strong> to run the SQL above.
        </p>
      )}
    </div>
  );
}
ChangePreviewPanel.displayName = 'ChangePreviewPanel';
