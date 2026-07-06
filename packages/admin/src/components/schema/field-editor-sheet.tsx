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

/** Initial form values for add mode ('' defaults) or edit mode (the field's). */
function initialFieldForm(field: FieldDefinition | null) {
  return {
    /** Saved identifier/type (null in add mode) — drives the change warnings. */
    originalName: field?.name ?? null,
    originalType: field?.columnType ?? null,
    name: field?.name ?? '',
    displayName: field?.displayName ?? '',
    description: field?.description ?? '',
    columnType: field?.columnType ?? 'text',
    defaultValue: field?.defaultValue ?? '',
    isRequired: field?.isRequired ?? false,
    isUnique: field?.isUnique ?? false,
    isIndexed: field?.isIndexed ?? false,
    min: field?.constraints?.min?.toString() ?? '',
    max: field?.constraints?.max?.toString() ?? '',
    pattern: field?.constraints?.pattern ?? '',
    message: field?.constraints?.message ?? '',
  };
}

/** Assembles the FieldConstraints object from the raw form inputs (undefined when empty). */
function buildFieldConstraints(inputs: {
  min: string;
  max: string;
  pattern: string;
  message: string;
  isEnum: boolean;
  choices: EnumChoice[];
}): FieldConstraints | undefined {
  const c: FieldConstraints = {};
  if (inputs.min !== '' && Number.isFinite(Number(inputs.min))) c.min = Number(inputs.min);
  if (inputs.max !== '' && Number.isFinite(Number(inputs.max))) c.max = Number(inputs.max);
  if (inputs.pattern.trim()) c.pattern = inputs.pattern.trim();
  if (inputs.message.trim()) c.message = inputs.message.trim();
  if (inputs.isEnum) {
    const values = inputs.choices.map((ch) => ch.value.trim()).filter(Boolean);
    if (values.length > 0) c.enumValues = values;
  }
  return Object.keys(c).length > 0 ? c : undefined;
}

/** The current form values, snapshotted for diffing against the original field. */
interface FieldFormSnapshot {
  name: string;
  displayName: string;
  description: string;
  columnType: string;
  isRequired: boolean;
  isUnique: boolean;
  isIndexed: boolean;
  defaultValue: string;
  constraints: FieldConstraints | undefined;
  uiOptions: Record<string, unknown> | undefined;
  backfillValue: string;
}

/** Structural-equality check for JSON bags (null ≡ undefined ≡ absent). */
function jsonChanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/** Name/display-name/description entries of the modification diff. */
function identityUpdates(field: FieldDefinition, v: FieldFormSnapshot): FieldModification {
  const u: FieldModification = {};
  if (v.name !== field.name) u.name = v.name;
  if (v.displayName !== field.displayName) u.displayName = v.displayName;
  if ((v.description || null) !== (field.description ?? null)) {
    u.description = v.description || null;
  }
  return u;
}

/** Type/flag/default entries of the modification diff. */
function structuralUpdates(field: FieldDefinition, v: FieldFormSnapshot): FieldModification {
  const u: FieldModification = {};
  if (v.columnType !== field.columnType) u.columnType = v.columnType;
  if (v.isRequired !== (field.isRequired ?? false)) u.isRequired = v.isRequired;
  if (v.isUnique !== (field.isUnique ?? false)) u.isUnique = v.isUnique;
  if (v.isIndexed !== (field.isIndexed ?? false)) u.isIndexed = v.isIndexed;
  if ((v.defaultValue || null) !== (field.defaultValue ?? null)) {
    u.defaultValue = v.defaultValue || null;
  }
  return u;
}

/** Constraint/uiOptions/backfill entries of the modification diff. */
function metadataUpdates(field: FieldDefinition, v: FieldFormSnapshot): FieldModification {
  const u: FieldModification = {};
  if (jsonChanged(v.constraints, field.constraints)) u.constraints = v.constraints ?? null;
  if (jsonChanged(v.uiOptions, field.uiOptions)) u.uiOptions = v.uiOptions ?? null;
  if (v.backfillValue) u.backfillValue = v.backfillValue;
  return u;
}

/** Computes the FieldModification that turns the original field into the form values. */
function computeFieldUpdates(field: FieldDefinition, v: FieldFormSnapshot): FieldModification {
  return {
    ...identityUpdates(field, v),
    ...structuralUpdates(field, v),
    ...metadataUpdates(field, v),
  };
}

/** Label for the footer's primary button across the add/preview/apply states. */
function primaryButtonLabel(
  busy: boolean,
  isEdit: boolean,
  isLink: boolean,
  previewValid: boolean,
): string {
  if (busy) return 'Working…';
  if (!isEdit) return isLink ? 'Create link' : 'Add field';
  return previewValid ? 'Apply changes' : 'Review changes';
}

/** Flags derived from the dry-run preview's error codes. */
function previewErrorFlags(preview: ChangePreview | null): {
  needsBackfill: boolean;
  blockedByBlock: boolean;
} {
  return {
    needsBackfill: preview?.errors.some((e) => e.code === 'REQUIRES_BACKFILL') ?? false,
    blockedByBlock: preview?.errors.some((e) => e.code === 'BLOCK_MANAGED_FIELD') ?? false,
  };
}

/** Whether the form is submittable: edit needs changes; add needs a name (+ link target). */
function canSubmitField(
  isEdit: boolean,
  hasChanges: boolean,
  name: string,
  isLink: boolean,
  linkTarget: string,
): boolean {
  if (isEdit) return hasChanges;
  return name.trim().length > 0 && (!isLink || linkTarget.length > 0);
}

/** Synthetic field definition driving the type-aware default-value editor. */
function makeDefaultEditorField(
  isLink: boolean,
  columnType: string,
  isEnum: boolean,
  constraints: FieldConstraints | undefined,
): FieldDefinition {
  return {
    name: 'default_value',
    displayName: 'Default value',
    columnName: 'default_value',
    columnType: isLink ? 'uuid' : columnType,
    constraints: isEnum && constraints?.enumValues ? { enumValues: constraints.enumValues } : null,
  };
}

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
  const initial = initialFieldForm(field);

  // --- Form state ---
  const [name, setName] = useState(initial.name);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [displayNameTouched, setDisplayNameTouched] = useState(isEdit);
  const [description, setDescription] = useState(initial.description);
  const [columnType, setColumnType] = useState(initial.columnType);
  const [defaultValue, setDefaultValue] = useState(initial.defaultValue);
  const [isRequired, setIsRequired] = useState(initial.isRequired);
  const [isUnique, setIsUnique] = useState(initial.isUnique);
  const [isIndexed, setIsIndexed] = useState(initial.isIndexed);
  const [min, setMin] = useState(initial.min);
  const [max, setMax] = useState(initial.max);
  const [pattern, setPattern] = useState(initial.pattern);
  const [message, setMessage] = useState(initial.message);
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
  // Identifier/type inputs are additionally never editable while block-locked.
  const structuralDisabled = isEdit && structuralLocked;

  // --- Assemble the constraint object from the inputs ---
  const constraints = useMemo(
    () => buildFieldConstraints({ min, max, pattern, message, isEnum, choices }),
    [min, max, pattern, message, isEnum, choices],
  );

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
    return computeFieldUpdates(field, {
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
    });
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
  const canSubmit = canSubmitField(isEdit, hasChanges, name, isLink, linkTarget);
  const { needsBackfill, blockedByBlock } = previewErrorFlags(preview);

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

  const defaultEditorField = makeDefaultEditorField(isLink, columnType, isEnum, constraints);

  return (
    <Sheet
      open
      onClose={onClose}
      title={isEdit ? `Edit field — ${field.displayName}` : 'Add field'}
      description={<SheetDescription blockOwner={blockOwner} objectName={object.displayName} />}
      className="max-w-[560px]"
      footer={
        <EditorFooter
          showForce={isEdit && blockOwner !== null}
          force={force}
          onForceChange={(v) => {
            setForce(v);
            invalidatePreview();
          }}
          canSubmit={canSubmit}
          busy={busy}
          label={primaryButtonLabel(busy, isEdit, isLink, preview?.isValid ?? false)}
          onCancel={onClose}
          onPrimary={onPrimary}
        />
      }
    >
      <div className="flex flex-col gap-4">
        {/* Identifier + display name (decoupled) */}
        <IdentifierInputs
          name={name}
          displayName={displayName}
          originalName={initial.originalName}
          disabled={structuralDisabled}
          onNameChange={(next) => {
            setName(next);
            if (!displayNameTouched) setDisplayName(titleCaseOf(next));
            invalidatePreview();
          }}
          onDisplayNameChange={(next) => {
            setDisplayName(next);
            setDisplayNameTouched(true);
            invalidatePreview();
          }}
        />

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
        <TypeSection
          columnTypes={columnTypes}
          columnType={columnType}
          originalType={initial.originalType}
          includeLink={!isEdit}
          disabled={structuralDisabled}
          onChange={(next) => {
            setColumnType(next);
            invalidatePreview();
          }}
        />

        {/* Link-to-record configuration (Tier 3A) */}
        {isLink && (
          <LinkConfigPanel
            targets={(objects.data ?? []).filter((o) => !o.isSystem && o.name !== object.name)}
            fieldName={name}
            linkTarget={linkTarget}
            onTargetChange={setLinkTarget}
            linkMultiple={linkMultiple}
            onMultipleChange={setLinkMultiple}
          />
        )}

        {/* Default value (not for links) */}
        {!isLink && !isEnum && (
          <div className="flex flex-col gap-1.5">
            <Label>Default value</Label>
            <GridCellEditor
              field={defaultEditorField}
              value={defaultValue}
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
            defaultValue={defaultValue}
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
          <ValidationPanel
            numeric={numeric}
            textLike={textLike}
            disabled={structuralLocked}
            min={min}
            max={max}
            pattern={pattern}
            message={message}
            onMinChange={(v) => {
              setMin(v);
              invalidatePreview();
            }}
            onMaxChange={(v) => {
              setMax(v);
              invalidatePreview();
            }}
            onPatternChange={(v) => {
              setPattern(v);
              invalidatePreview();
            }}
            onMessageChange={(v) => {
              setMessage(v);
              invalidatePreview();
            }}
          />
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

/** Identifier + display-name inputs, with the rename API-surface warning. */
function IdentifierInputs({
  name,
  displayName,
  originalName,
  disabled,
  onNameChange,
  onDisplayNameChange,
}: {
  name: string;
  displayName: string;
  /** The field's saved identifier in edit mode (null in add mode). */
  originalName: string | null;
  disabled: boolean;
  onNameChange: (name: string) => void;
  onDisplayNameChange: (displayName: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fe-name">Identifier</Label>
        <Input
          id="fe-name"
          value={name}
          disabled={disabled}
          onChange={(e) => onNameChange(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          placeholder="due_date"
          className="font-mono"
        />
        {originalName !== null && name !== originalName && (
          <p className="text-xs text-ion-amber">
            Renaming changes the API name — existing queries using “{originalName}” will break.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fe-display">Display name</Label>
        <Input
          id="fe-display"
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder="Due Date"
        />
      </div>
    </div>
  );
}
IdentifierInputs.displayName = 'IdentifierInputs';

/** Type picker with the type-change validation notice in edit mode. */
function TypeSection({
  columnTypes,
  columnType,
  originalType,
  includeLink,
  disabled,
  onChange,
}: {
  columnTypes: ColumnType[];
  columnType: string;
  /** The field's saved type in edit mode (null in add mode). */
  originalType: string | null;
  includeLink: boolean;
  disabled: boolean;
  onChange: (columnType: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="fe-type">Type</Label>
      <FieldTypePicker
        id="fe-type"
        columnTypes={columnTypes}
        value={columnType}
        includeLink={includeLink}
        disabled={disabled}
        onChange={onChange}
      />
      {originalType !== null && columnType !== originalType && (
        <p className="text-xs text-ion-amber">
          Type changes are validated against existing data before applying.
        </p>
      )}
    </div>
  );
}
TypeSection.displayName = 'TypeSection';

/** Sheet subtitle: block-protection notice for block-managed fields. */
function SheetDescription({
  blockOwner,
  objectName,
}: {
  blockOwner: string | null;
  objectName: string;
}) {
  if (!blockOwner) return <>{`on ${objectName}`}</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <ShieldAlert className="h-3.5 w-3.5 text-ion-amber" aria-hidden />
      Managed by the <Badge variant="secondary">{blockOwner}</Badge> block — structural changes are
      protected.
    </span>
  );
}
SheetDescription.displayName = 'SheetDescription';

/** Footer: optional override-protection switch + Cancel / primary action. */
function EditorFooter({
  showForce,
  force,
  onForceChange,
  canSubmit,
  busy,
  label,
  onCancel,
  onPrimary,
}: {
  showForce: boolean;
  force: boolean;
  onForceChange: (force: boolean) => void;
  canSubmit: boolean;
  busy: boolean;
  label: string;
  onCancel: () => void;
  onPrimary: () => void;
}) {
  return (
    <>
      {showForce && (
        // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Switch (renders a button role=switch)
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={force}
            onCheckedChange={(v) => onForceChange(v === true)}
            aria-label="Override block protection"
          />
          Override protection
        </label>
      )}
      <div className="ml-auto flex gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onPrimary} disabled={!canSubmit || busy}>
          {label}
        </Button>
      </div>
    </>
  );
}
EditorFooter.displayName = 'EditorFooter';

/** Link-to-record configuration (Tier 3A): target object + single/multiple. */
function LinkConfigPanel({
  targets,
  fieldName,
  linkTarget,
  onTargetChange,
  linkMultiple,
  onMultipleChange,
}: {
  targets: { name: string; displayName: string }[];
  fieldName: string;
  linkTarget: string;
  onTargetChange: (target: string) => void;
  linkMultiple: boolean;
  onMultipleChange: (multiple: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-ion-purple/30 bg-ion-purple/5 p-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fe-link-target">Target object</Label>
        <Select
          id="fe-link-target"
          value={linkTarget}
          onChange={(e) => onTargetChange(e.target.value)}
        >
          <option value="">Choose…</option>
          {targets.map((o) => (
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
          onCheckedChange={(v) => onMultipleChange(v === true)}
          aria-label="Allow linking multiple records"
        />
        Allow linking to multiple records
      </label>
      <p className="text-xs text-muted-foreground">
        {linkMultiple
          ? 'Creates a many-to-many relationship via a junction table.'
          : `Creates a "${fieldName || 'link'}_id" foreign-key column plus a many-to-one relationship.`}
      </p>
    </div>
  );
}
LinkConfigPanel.displayName = 'LinkConfigPanel';

/** Bounds/pattern/message inputs — enforced as CHECK constraints in Postgres. */
function ValidationPanel({
  numeric,
  textLike,
  disabled,
  min,
  max,
  pattern,
  message,
  onMinChange,
  onMaxChange,
  onPatternChange,
  onMessageChange,
}: {
  numeric: boolean;
  textLike: boolean;
  disabled: boolean;
  min: string;
  max: string;
  pattern: string;
  message: string;
  onMinChange: (value: string) => void;
  onMaxChange: (value: string) => void;
  onPatternChange: (value: string) => void;
  onMessageChange: (value: string) => void;
}) {
  return (
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
            disabled={disabled}
            onChange={(e) => onMinChange(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fe-max">{numeric ? 'Maximum value' : 'Maximum length'}</Label>
          <Input
            id="fe-max"
            type="number"
            value={max}
            disabled={disabled}
            onChange={(e) => onMaxChange(e.target.value)}
          />
        </div>
      </div>
      {textLike && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fe-pattern">Pattern (POSIX regex)</Label>
          <Input
            id="fe-pattern"
            value={pattern}
            disabled={disabled}
            onChange={(e) => onPatternChange(e.target.value)}
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
          disabled={disabled}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Must look like AB-123"
        />
      </div>
    </div>
  );
}
ValidationPanel.displayName = 'ValidationPanel';

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
