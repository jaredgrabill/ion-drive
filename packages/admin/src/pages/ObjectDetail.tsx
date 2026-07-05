import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { DataGrid } from '../components/DataGrid';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  Input,
  Label,
  Select,
  Spinner,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import { cn } from '../lib/utils';

export function ObjectDetail() {
  const { name } = useParams({ from: '/objects/$name' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'fields' | 'data'>('data');
  const [addFieldOpen, setAddFieldOpen] = useState(false);

  const object = useQuery({ queryKey: ['object', name], queryFn: () => api.getObject(name) });
  const columnTypes = useQuery({ queryKey: ['column-types'], queryFn: () => api.columnTypes() });

  const removeField = useMutation({
    mutationFn: (fieldName: string) => api.removeField(name, fieldName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['object', name] }),
  });
  const deleteObject = useMutation({
    mutationFn: () => api.deleteObject(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objects'] });
      navigate({ to: '/objects' });
    },
  });

  if (object.isLoading) return <Spinner />;
  if (object.isError || !object.data) {
    return <p className="text-destructive">Object not found.</p>;
  }

  const obj = object.data;
  const userFields = obj.fields.filter((f) => !f.isSystem);

  return (
    <div className="mx-auto max-w-5xl">
      <button
        type="button"
        onClick={() => navigate({ to: '/objects' })}
        className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Data Objects
      </button>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{obj.displayName}</h1>
          <p className="font-mono text-xs text-muted-foreground">{obj.name}</p>
        </div>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm(`Delete "${obj.displayName}" and all its data? This cannot be undone.`)) {
              deleteObject.mutate();
            }
          }}
        >
          <Trash2 className="h-4 w-4" /> Delete Object
        </Button>
      </div>

      <div className="mb-4 flex gap-1 border-b border-border">
        {(['data', 'fields'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize',
              tab === t
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'data' ? (
        <DataGrid object={obj} />
      ) : (
        <Card>
          <CardContent>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Fields</h2>
              <Button size="sm" onClick={() => setAddFieldOpen(true)}>
                <Plus className="h-4 w-4" /> Add field
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">Flags</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {obj.fields.map((f) => (
                    <tr key={f.name} className="border-b border-border/60">
                      <td className="py-2 pr-4 font-mono text-xs">{f.name}</td>
                      <td className="py-2 pr-4">{f.columnType}</td>
                      <td className="py-2 pr-4">
                        <div className="flex gap-1">
                          {f.isSystem && <Badge variant="outline">system</Badge>}
                          {f.isRequired && <Badge>required</Badge>}
                          {f.isUnique && <Badge variant="secondary">unique</Badge>}
                          {f.isIndexed && <Badge variant="secondary">indexed</Badge>}
                        </div>
                      </td>
                      <td className="py-2 text-right">
                        {!f.isSystem && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${f.name}`}
                            onClick={() => {
                              if (confirm(`Remove field "${f.name}"? Column data will be lost.`)) {
                                removeField.mutate(f.name);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {userFields.length === 0 && (
              <p className="mt-3 text-sm text-muted-foreground">No custom fields yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      {addFieldOpen && (
        <AddFieldDialog
          columnTypes={(columnTypes.data ?? []).map((c) => c.name)}
          onClose={() => setAddFieldOpen(false)}
          onAdded={() => {
            setAddFieldOpen(false);
            queryClient.invalidateQueries({ queryKey: ['object', name] });
          }}
          objectName={name}
        />
      )}
    </div>
  );
}

function AddFieldDialog({
  objectName,
  columnTypes,
  onClose,
  onAdded,
}: {
  objectName: string;
  columnTypes: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [fieldName, setFieldName] = useState('');
  const [columnType, setColumnType] = useState('text');
  const [isRequired, setIsRequired] = useState(false);
  const [isUnique, setIsUnique] = useState(false);
  const [isIndexed, setIsIndexed] = useState(false);

  const add = useMutation({
    mutationFn: () =>
      api.addField(objectName, {
        name: fieldName.trim(),
        displayName: fieldName.trim(),
        columnType,
        isRequired,
        isUnique,
        isIndexed,
      }),
    onSuccess: onAdded,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add Field"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} disabled={!fieldName.trim() || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add field'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Field name</Label>
          <Input
            value={fieldName}
            onChange={(e) => setFieldName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
            placeholder="email"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Type</Label>
          <Select value={columnType} onChange={(e) => setColumnType(e.target.value)}>
            {columnTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isRequired}
              onChange={(e) => setIsRequired(e.target.checked)}
            />{' '}
            Required
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isUnique}
              onChange={(e) => setIsUnique(e.target.checked)}
            />{' '}
            Unique
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isIndexed}
              onChange={(e) => setIsIndexed(e.target.checked)}
            />{' '}
            Indexed
          </label>
        </div>
        {add.error && (
          <p className="text-sm text-destructive">
            {add.error instanceof ApiError ? add.error.message : 'Failed to add field'}
          </p>
        )}
      </div>
    </Dialog>
  );
}
