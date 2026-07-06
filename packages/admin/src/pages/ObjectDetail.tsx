/**
 * ObjectDetail — one data object across five tabs.
 *
 *  - **Data** — the Airtable-grade DataGrid (Phase 8, Tier 1B)
 *  - **Schema** — field table with type icons and add/remove field
 *  - **Relationships** — FK list + Add Relationship dialog
 *  - **API** — generated REST/GraphQL/MCP reference with copy buttons
 *  - **Settings** — danger zone (delete object with type-to-confirm)
 *
 * The header shows a deterministic-color letter icon, live field/
 * relationship/record counts, and an overflow menu (export schema JSON,
 * copy REST URL, open GraphiQL).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Copy,
  GripVertical,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { DataGrid, linkTargetOf, linkedRelationshipOf } from '../components/data';
import { FieldEditorSheet } from '../components/schema';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Label,
  Select,
  SimpleTooltip,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { DataObjectDefinition, FieldDefinition, RelationshipDefinition } from '../lib/types';
import { cn } from '../lib/utils';

// --- Object icon ---------------------------------------------------------

const ICON_TINTS = [
  'bg-ion-blue/15 text-ion-blue',
  'bg-ion-purple/15 text-ion-purple',
  'bg-ion-cyan/15 text-ion-cyan',
  'bg-ion-green/15 text-ion-green',
  'bg-ion-amber/15 text-ion-amber',
];

function objectTint(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return ICON_TINTS[Math.abs(hash) % ICON_TINTS.length] ?? ICON_TINTS[0] ?? '';
}

// --- Page ------------------------------------------------------------------

export function ObjectDetail() {
  const { name } = useParams({ from: '/objects/$name' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const object = useQuery({ queryKey: ['object', name], queryFn: () => api.getObject(name) });
  const records = useQuery({
    queryKey: ['records', name, '?page=1&pageSize=1'],
    queryFn: () => api.listRecords(name, '?page=1&pageSize=1'),
  });

  const deleteObject = useMutation({
    mutationFn: () => api.deleteObject(name),
    onSuccess: () => {
      toast.success(`Deleted ${name}`);
      void queryClient.invalidateQueries({ queryKey: ['objects'] });
      void navigate({ to: '/objects' });
    },
    onError: (error) =>
      toast.error(
        `Failed to delete: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  if (object.isLoading) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4" aria-hidden>
        <Skeleton className="h-16 w-96" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (object.isError || !object.data) {
    return <p className="text-destructive">Object not found.</p>;
  }

  const obj = object.data;
  const relationships = obj.relationships ?? [];
  const recordCount = records.data?.pagination.totalCount;
  const restUrl = `${window.location.origin}/api/v1/data/${obj.name}`;

  return (
    <div className="mx-auto max-w-6xl">
      <button
        type="button"
        onClick={() => void navigate({ to: '/objects' })}
        className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Data Objects
      </button>

      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={`flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold ${objectTint(obj.name)}`}
          >
            {obj.displayName.charAt(0).toUpperCase()}
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{obj.displayName}</h1>
            <p className="text-sm text-muted-foreground">
              <span className="font-mono text-xs">{obj.name}</span> · {obj.fields.length} fields ·{' '}
              {relationships.length} relationships ·{' '}
              {recordCount !== undefined ? recordCount.toLocaleString() : '…'} records
            </p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Object actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${obj.name}.schema.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export schema as JSON
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                navigator.clipboard?.writeText(restUrl);
                toast('Copied REST URL');
              }}
            >
              Copy REST base URL
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.open('/api/v1/graphql', '_blank')}>
              Open GraphiQL
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Tabs defaultValue="data">
        <TabsList>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          <TabsTrigger value="api">API</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="data">
          <DataGrid object={obj} />
        </TabsContent>

        <TabsContent value="schema">
          <SchemaTab object={obj} />
        </TabsContent>

        <TabsContent value="relationships">
          <RelationshipsTab object={obj} relationships={relationships} />
        </TabsContent>

        <TabsContent value="api">
          <ApiTab object={obj} restUrl={restUrl} />
        </TabsContent>

        <TabsContent value="settings">
          <Card className="border-destructive/40">
            <CardContent className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">Delete this object</p>
                <p className="text-sm text-muted-foreground">
                  Drops the table and all {recordCount?.toLocaleString() ?? ''} records. This cannot
                  be undone.
                </p>
              </div>
              <Button
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
                className="gap-1.5"
              >
                <Trash2 className="h-4 w-4" /> Delete Object
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete Data Object"
        description={`This will permanently delete "${obj.displayName}" and all its records. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        requireText={obj.name}
        onConfirm={() => deleteObject.mutate()}
      />
    </div>
  );
}
ObjectDetail.displayName = 'ObjectDetail';

// --- Schema tab -----------------------------------------------------------

/** Owning block name for a block-managed field, or null. */
function blockOwnerOf(managedBy: string | undefined): string | null {
  return managedBy?.startsWith('block:') ? managedBy.slice('block:'.length) : null;
}

/** Flag badges for a field row: system/block/required/unique/indexed/choices. */
function FieldFlags({ field }: { field: FieldDefinition }) {
  const owner = blockOwnerOf(field.managedBy);
  return (
    <div className="flex flex-wrap gap-1">
      {field.isSystem && <Badge variant="outline">system</Badge>}
      {owner && (
        <SimpleTooltip label={`Managed by the "${owner}" block — structural changes are protected`}>
          <Badge variant="secondary" className="gap-1">
            <ShieldCheck className="h-3 w-3" aria-hidden /> {owner}
          </Badge>
        </SimpleTooltip>
      )}
      {field.isRequired && <Badge>required</Badge>}
      {field.isUnique && <Badge variant="secondary">unique</Badge>}
      {field.isIndexed && <Badge variant="secondary">indexed</Badge>}
      {field.constraints?.enumValues && (
        <Badge variant="outline">{field.constraints.enumValues.length} choices</Badge>
      )}
    </div>
  );
}
FieldFlags.displayName = 'FieldFlags';

/**
 * One row of the schema field table. User fields (`index !== null`) are
 * drag-to-reorderable and get edit/remove actions; system fields render
 * pinned and read-only.
 */
function FieldRow({
  object,
  field,
  index,
  dragging,
  pgType,
  onDragStart,
  onDrop,
  onDragEnd,
  onEdit,
  onRemove,
}: {
  object: DataObjectDefinition;
  field: FieldDefinition;
  /** Position among the user fields, or null for pinned system fields. */
  index: number | null;
  dragging: boolean;
  pgType: string | undefined;
  onDragStart: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
  onEdit: (field: FieldDefinition) => void;
  onRemove: (field: FieldDefinition) => void;
}) {
  const linkRel = linkedRelationshipOf(object, field);
  const draggable = index !== null;
  return (
    <tr
      className={cn('border-b border-border/60 last:border-0', dragging && 'opacity-40')}
      draggable={draggable}
      onDragStart={draggable ? () => onDragStart(index) : undefined}
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={draggable ? () => onDrop(index) : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <td className="py-2 pr-4">
        <span className="flex items-center gap-1.5">
          {draggable && (
            <GripVertical
              className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/40"
              aria-hidden
            />
          )}
          <span>
            <span className="font-medium">{field.displayName}</span>
            <span className="ml-2 font-mono text-xs text-muted-foreground">{field.name}</span>
            {field.description && (
              <span className="block max-w-md truncate text-xs text-muted-foreground">
                {field.description}
              </span>
            )}
          </span>
        </span>
      </td>
      <td className="py-2 pr-4">
        {linkRel ? (
          <Badge variant="info" className="gap-1 font-mono">
            <Link2 className="h-3 w-3" aria-hidden /> {linkTargetOf(object, linkRel)}
          </Badge>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <Badge variant="outline" className="font-mono">
              {field.columnType}
            </Badge>
            <span className="font-mono text-[10px] text-muted-foreground">{pgType}</span>
          </span>
        )}
      </td>
      <td className="py-2 pr-4">
        <FieldFlags field={field} />
      </td>
      <td className="py-2 text-right">
        {!field.isSystem && !field.isPrimary && (
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${field.name}`}
              onClick={() => onEdit(field)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${field.name}`}
              onClick={() => onRemove(field)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}
FieldRow.displayName = 'FieldRow';

function SchemaTab({ object }: { object: DataObjectDefinition }) {
  const queryClient = useQueryClient();
  const [editorField, setEditorField] = useState<FieldDefinition | null | 'add'>(null);
  const [removingField, setRemovingField] = useState<FieldDefinition | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const columnTypes = useQuery({ queryKey: ['column-types'], queryFn: () => api.columnTypes() });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['object', object.name] });

  // System fields pinned first, user fields in their persisted sortOrder.
  const systemFields = object.fields.filter((f) => f.isSystem || f.isPrimary);
  const userFields = object.fields
    .filter((f) => !f.isSystem && !f.isPrimary)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const removeField = useMutation({
    mutationFn: (field: FieldDefinition) =>
      api.removeField(object.name, field.name, blockOwnerOf(field.managedBy) !== null),
    onSuccess: () => {
      toast.success('Field removed');
      refresh();
    },
    onError: (error) =>
      toast.error(
        `Failed to remove: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  // Drag-to-reorder persists sortOrder (presentation-only, always allowed).
  const reorder = useMutation({
    mutationFn: async (moved: { name: string; sortOrder: number }[]) => {
      for (const entry of moved) {
        await api.modifyField(object.name, entry.name, { sortOrder: entry.sortOrder });
      }
    },
    onSuccess: refresh,
    onError: (error) =>
      toast.error(
        `Failed to reorder: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const onDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      return;
    }
    const next = [...userFields];
    const [moved] = next.splice(dragIndex, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    setDragIndex(null);
    reorder.mutate(
      next
        .map((f, i) => ({ name: f.name, sortOrder: (i + 1) * 10, prev: f.sortOrder ?? 0 }))
        .filter((e) => e.prev !== e.sortOrder)
        .map(({ name, sortOrder }) => ({ name, sortOrder })),
    );
  };

  const typeInfoOf = (columnType: string) =>
    (columnTypes.data ?? []).find((t) => t.name === columnType);

  const renderRow = (field: FieldDefinition, index: number | null) => (
    <FieldRow
      key={field.name}
      object={object}
      field={field}
      index={index}
      dragging={index !== null && dragIndex === index}
      pgType={typeInfoOf(field.columnType)?.pg}
      onDragStart={setDragIndex}
      onDrop={onDrop}
      onDragEnd={() => setDragIndex(null)}
      onEdit={setEditorField}
      onRemove={setRemovingField}
    />
  );

  const removingOwner = removingField ? blockOwnerOf(removingField.managedBy) : null;

  return (
    <Card>
      <CardContent>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Fields</h2>
          <Button size="sm" onClick={() => setEditorField('add')} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add field
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Type
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Flags
                </th>
                <th scope="col" className="py-2" />
              </tr>
            </thead>
            <tbody>
              {systemFields.map((field) => renderRow(field, null))}
              {userFields.map((field, index) => renderRow(field, index))}
            </tbody>
          </table>
        </div>
      </CardContent>

      {editorField !== null && (
        <FieldEditorSheet
          object={object}
          field={editorField === 'add' ? null : editorField}
          columnTypes={columnTypes.data ?? []}
          onClose={() => setEditorField(null)}
          onSaved={() => {
            setEditorField(null);
            refresh();
          }}
        />
      )}

      <AlertDialog
        open={removingField !== null}
        onClose={() => setRemovingField(null)}
        title="Remove field"
        description={
          removingOwner
            ? `"${removingField?.name}" is managed by the "${removingOwner}" block — removing it may break that block. Its column and data will be lost.`
            : `Remove field "${removingField?.name ?? ''}"? Its column and data will be lost.`
        }
        confirmLabel="Remove"
        confirmVariant="destructive"
        requireText={removingOwner ? (removingField?.name ?? undefined) : undefined}
        onConfirm={() => {
          if (removingField) removeField.mutate(removingField);
        }}
      />
    </Card>
  );
}
SchemaTab.displayName = 'SchemaTab';

// --- Relationships tab ------------------------------------------------------

function RelationshipsTab({
  object,
  relationships,
}: {
  object: DataObjectDefinition;
  relationships: RelationshipDefinition[];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Foreign-key links between this object and others.
        </p>
        <Button size="sm" onClick={() => setAdding(true)} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add relationship
        </Button>
      </div>
      {relationships.length === 0 ? (
        <EmptyState
          title="No relationships"
          hint="Link this object to another to expose expand queries and related records."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {relationships.map((rel) => {
                  const other =
                    rel.targetObjectName === object.name
                      ? rel.sourceObjectName
                      : rel.targetObjectName;
                  return (
                    <tr key={rel.name} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 font-medium">{rel.displayName}</td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-muted-foreground">
                          {rel.sourceObjectName} → {rel.targetObjectName}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="info">{rel.type.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void navigate({ to: '/objects/$name', params: { name: other } })
                          }
                        >
                          Open {other}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {adding && (
        <AddRelationshipDialog
          sourceObject={object.name}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            toast.success('Relationship created');
            void queryClient.invalidateQueries({ queryKey: ['object', object.name] });
          }}
        />
      )}
    </>
  );
}
RelationshipsTab.displayName = 'RelationshipsTab';

// --- API tab ------------------------------------------------------------------

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
          {label}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy ${label}`}
          onClick={() => {
            navigator.clipboard?.writeText(code);
            toast('Copied to clipboard');
          }}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-xs leading-relaxed">
        {code}
      </pre>
    </div>
  );
}
CodeBlock.displayName = 'CodeBlock';

function ApiTab({ object, restUrl }: { object: DataObjectDefinition; restUrl: string }) {
  const graphqlQuery = `query {
  ${object.name}(page: 1, pageSize: 25) {
    data { id }
    pagination { totalCount }
  }
}`;
  return (
    <div className="flex flex-col gap-4">
      <CodeBlock
        label="REST — list records"
        code={`curl "${restUrl}?page=1&pageSize=25" \\\n  -H "X-API-Key: iond_..."`}
      />
      <CodeBlock
        label="REST — create record"
        code={`curl -X POST "${restUrl}" \\\n  -H "content-type: application/json" \\\n  -H "X-API-Key: iond_..." \\\n  -d '{ "field": "value" }'`}
      />
      <CodeBlock label={`GraphQL — ${window.location.origin}/api/v1/graphql`} code={graphqlQuery} />
      <CodeBlock
        label="MCP — query_data tool"
        code={`{ "tool": "query_data", "arguments": { "object": "${object.name}", "page": 1 } }`}
      />
      <p className="text-xs text-muted-foreground">
        Full reference:{' '}
        <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="underline">
          OpenAPI spec
        </a>{' '}
        (always generated from the live schema).
      </p>
    </div>
  );
}
ApiTab.displayName = 'ApiTab';

// --- Dialogs -------------------------------------------------------------------

function AddRelationshipDialog({
  sourceObject,
  onClose,
  onAdded,
}: {
  sourceObject: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const objects = useQuery({ queryKey: ['objects'], queryFn: () => api.listObjects() });
  const targets = (objects.data ?? []).filter((o) => !o.isSystem);
  const [name, setName] = useState('');
  const [type, setType] = useState<'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many'>(
    'many_to_one',
  );
  const [target, setTarget] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api.addRelationship({
        name: name.trim(),
        displayName: name.trim(),
        type,
        sourceObjectName: sourceObject,
        targetObjectName: target,
      }),
    onSuccess: onAdded,
    onError: (error) =>
      toast.error(
        `Failed to create: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add Relationship"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} disabled={!name.trim() || !target || add.isPending}>
            {add.isPending ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rel-name">Name (identifier)</Label>
          <Input
            id="rel-name"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
            placeholder="company"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rel-type">Type</Label>
            <Select
              id="rel-type"
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
            >
              <option value="many_to_one">many to one</option>
              <option value="one_to_many">one to many</option>
              <option value="one_to_one">one to one</option>
              <option value="many_to_many">many to many</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rel-target">Target object</Label>
            <Select id="rel-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose…</option>
              {targets
                .filter((o) => o.name !== sourceObject)
                .map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.displayName}
                  </option>
                ))}
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Source: <span className="font-mono">{sourceObject}</span> — a{' '}
          <span className="font-mono">{type.replace(/_/g, ' ')}</span> link to the target.
        </p>
      </div>
    </Dialog>
  );
}
AddRelationshipDialog.displayName = 'AddRelationshipDialog';
