import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, CardContent, Dialog, Input, Label, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { PermissionGrant, Role } from '../lib/types';

const ALL_ACTIONS = ['create', 'read', 'update', 'delete', 'manage'];

export function Roles() {
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.listRoles() });
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);

  const del = useMutation({
    mutationFn: (id: string) => api.deleteRole(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roles'] }),
  });

  if (roles.isLoading) return <Spinner />;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Roles</h1>
          <p className="text-sm text-muted-foreground">
            Grant actions on data objects and platform resources.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Role
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {(roles.data ?? []).map((role) => (
          <Card key={role.id}>
            <CardContent className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">{role.name}</h3>
                  {role.is_system && <Badge variant="outline">system</Badge>}
                </div>
                {role.description && (
                  <p className="mt-0.5 text-sm text-muted-foreground">{role.description}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-1">
                  {role.permissions.map((p, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: grants have no id
                    <Badge key={i} variant="secondary">
                      {p.resource}: {p.actions.join('/')}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" onClick={() => setEditing(role)}>
                  Edit
                </Button>
                {!role.is_system && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete role"
                    onClick={() => confirm(`Delete role "${role.name}"?`) && del.mutate(role.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {(creating || editing) && (
        <RoleDialog
          role={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['roles'] });
          }}
        />
      )}
    </div>
  );
}

function RoleDialog({
  role,
  onClose,
  onSaved,
}: { role: Role | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [grants, setGrants] = useState<PermissionGrant[]>(
    role?.permissions ?? [{ resource: '*', actions: ['read'] }],
  );

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        description: description || undefined,
        permissions: grants,
      };
      return role ? api.updateRole(role.id, payload) : api.createRole(payload);
    },
    onSuccess: onSaved,
  });

  const toggleAction = (gi: number, action: string) =>
    setGrants((prev) =>
      prev.map((g, i) =>
        i === gi
          ? {
              ...g,
              actions: g.actions.includes(action)
                ? g.actions.filter((a) => a !== action)
                : [...g.actions, action],
            }
          : g,
      ),
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={role ? `Edit ${role.name}` : 'New Role'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={role?.is_system}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label>Permissions</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setGrants((p) => [...p, { resource: '', actions: ['read'] }])}
            >
              <Plus className="h-3.5 w-3.5" /> Add grant
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {grants.map((g, gi) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: grant rows have no id
              <div key={gi} className="rounded-md border border-border p-2">
                <div className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="resource (object name or *)"
                    value={g.resource}
                    onChange={(e) =>
                      setGrants((p) =>
                        p.map((x, i) => (i === gi ? { ...x, resource: e.target.value } : x)),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove grant"
                    onClick={() => setGrants((p) => p.filter((_, i) => i !== gi))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs">
                  {ALL_ACTIONS.map((a) => (
                    <label key={a} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={g.actions.includes(a)}
                        onChange={() => toggleAction(gi, a)}
                      />
                      {a}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {save.error && (
          <p className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : 'Failed to save role'}
          </p>
        )}
      </div>
    </Dialog>
  );
}
