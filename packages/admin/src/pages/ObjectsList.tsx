/**
 * ObjectsList — data-object gallery + creation dialog.
 *
 * Cards link to ObjectDetail. The create dialog composes name/display/
 * description plus draft fields (name, type, required Checkbox). The
 * command palette's "Create new object" action sets a sessionStorage flag
 * this page reads on mount to auto-open the dialog. Mutations toast.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CREATE_OBJECT_FLAG } from '../components/layout/command-palette';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { FieldDefinition } from '../lib/types';

interface DraftField {
  name: string;
  columnType: string;
  isRequired: boolean;
}

export function ObjectsList() {
  const queryClient = useQueryClient();
  const objects = useQuery({ queryKey: ['objects'], queryFn: () => api.listObjects() });
  const columnTypes = useQuery({ queryKey: ['column-types'], queryFn: () => api.columnTypes() });
  const [open, setOpen] = useState(() => {
    const flagged = sessionStorage.getItem(CREATE_OBJECT_FLAG) === '1';
    if (flagged) sessionStorage.removeItem(CREATE_OBJECT_FLAG);
    return flagged;
  });

  const userObjects = (objects.data ?? []).filter((o) => !o.isSystem);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Data Objects</h1>
          <p className="text-sm text-muted-foreground">
            Define tables, fields, and relationships at runtime.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> New Object
        </Button>
      </div>

      {objects.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : userObjects.length === 0 ? (
        <EmptyState
          icon={<Database className="h-8 w-8" />}
          title="No data objects yet"
          hint="Create your first object to expose REST, GraphQL, and MCP endpoints."
          action={
            <Button size="sm" onClick={() => setOpen(true)}>
              New Object
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {userObjects.map((o) => (
            <Link key={o.name} to="/objects/$name" params={{ name: o.name }}>
              <Card className="h-full transition-colors hover:border-ring">
                <CardContent>
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">{o.displayName}</h3>
                    <Badge variant="outline">{o.fieldCount} fields</Badge>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{o.name}</p>
                  {o.description && (
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                      {o.description}
                    </p>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {open && (
        <CreateObjectDialog
          columnTypes={(columnTypes.data ?? []).map((c) => c.name)}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            toast.success('Object created — REST, GraphQL, and MCP endpoints are live');
            void queryClient.invalidateQueries({ queryKey: ['objects'] });
          }}
        />
      )}
    </div>
  );
}
ObjectsList.displayName = 'ObjectsList';

// --- Create dialog -----------------------------------------------------------

function CreateObjectDialog({
  columnTypes,
  onClose,
  onCreated,
}: {
  columnTypes: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<DraftField[]>([
    { name: '', columnType: 'text', isRequired: false },
  ]);

  const create = useMutation({
    mutationFn: () => {
      const cleanFields: Partial<FieldDefinition>[] = fields
        .filter((f) => f.name.trim())
        .map((f) => ({
          name: f.name.trim(),
          displayName: f.name.trim(),
          columnType: f.columnType,
          isRequired: f.isRequired,
        }));
      return api.createObject({
        name: name.trim(),
        displayName: displayName.trim() || name.trim(),
        description: description || undefined,
        fields: cleanFields,
      });
    },
    onSuccess: onCreated,
    onError: (error) =>
      toast.error(
        `Failed to create: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const updateField = (index: number, patch: Partial<DraftField>) =>
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  return (
    <Dialog
      open
      onClose={onClose}
      title="New Data Object"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="obj-name">Name (identifier)</Label>
            <Input
              id="obj-name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
              placeholder="contacts"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="obj-display">Display name</Label>
            <Input
              id="obj-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Contacts"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="obj-description">Description</Label>
          <Input
            id="obj-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>

        <div className="mt-2">
          <div className="mb-2 flex items-center justify-between">
            <Label>Fields</Label>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() =>
                setFields((prev) => [...prev, { name: '', columnType: 'text', isRequired: false }])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add field
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {fields.map((field, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: draft rows have no stable id
              <div key={index} className="flex items-center gap-2">
                <Input
                  className="flex-1"
                  value={field.name}
                  placeholder="field_name"
                  aria-label="Field name"
                  onChange={(e) =>
                    updateField(index, {
                      name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                    })
                  }
                />
                <Select
                  className="w-40"
                  value={field.columnType}
                  aria-label="Field type"
                  onChange={(e) => updateField(index, { columnType: e.target.value })}
                >
                  {columnTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (renders a button role=checkbox) */}
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={field.isRequired}
                    onCheckedChange={(v) => updateField(index, { isRequired: v === true })}
                    aria-label="Required"
                  />
                  req
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setFields((prev) => prev.filter((_, i) => i !== index))}
                  aria-label="Remove field"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
CreateObjectDialog.displayName = 'CreateObjectDialog';
