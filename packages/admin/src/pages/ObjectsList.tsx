import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Spinner,
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
  const [open, setOpen] = useState(false);

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
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> New Object
        </Button>
      </div>

      {objects.isLoading ? (
        <Spinner />
      ) : userObjects.length === 0 ? (
        <EmptyState
          title="No data objects yet"
          hint="Create your first object to expose REST, GraphQL, and MCP endpoints."
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
                    <p className="mt-2 text-sm text-muted-foreground">{o.description}</p>
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
            queryClient.invalidateQueries({ queryKey: ['objects'] });
          }}
        />
      )}
    </div>
  );
}

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
  });

  const updateField = (i: number, patch: Partial<DraftField>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

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
            <Label>Name (identifier)</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
              placeholder="contacts"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Display name</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Contacts"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Description</Label>
          <Input
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
              onClick={() =>
                setFields((p) => [...p, { name: '', columnType: 'text', isRequired: false }])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add field
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {fields.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: draft rows have no stable id
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="flex-1"
                  value={f.name}
                  placeholder="field_name"
                  onChange={(e) =>
                    updateField(i, {
                      name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                    })
                  }
                />
                <Select
                  className="w-40"
                  value={f.columnType}
                  onChange={(e) => updateField(i, { columnType: e.target.value })}
                >
                  {columnTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={f.isRequired}
                    onChange={(e) => updateField(i, { isRequired: e.target.checked })}
                  />
                  req
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setFields((p) => p.filter((_, idx) => idx !== i))}
                  aria-label="Remove field"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {create.error && (
          <p className="text-sm text-destructive">
            {create.error instanceof ApiError ? create.error.message : 'Failed to create object'}
          </p>
        )}
      </div>
    </Dialog>
  );
}
