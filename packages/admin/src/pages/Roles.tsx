/**
 * Roles — RBAC role list with permission-grant editor.
 *
 * Each role card shows its grants as badges; the editor dialog manages
 * resource × action grants (Checkbox per action). Deletion goes through an
 * AlertDialog and all mutations toast their outcome.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  Input,
  Label,
  Skeleton,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { PermissionGrant, Role } from '../lib/types';

const ALL_ACTIONS = ['create', 'read', 'update', 'delete', 'manage'];

export function Roles() {
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.listRoles() });
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);

  const del = useMutation({
    mutationFn: (id: string) => api.deleteRole(id),
    onSuccess: () => {
      toast.success('Role deleted');
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (error) =>
      toast.error(
        `Failed to delete: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Roles</h1>
          <p className="text-sm text-muted-foreground">
            Grant actions on data objects and platform resources.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> New Role
        </Button>
      </div>

      {roles.isLoading ? (
        <div className="flex flex-col gap-3" aria-hidden>
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
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
                    {role.permissions.map((grant, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: grants have no id
                      <Badge key={i} variant="secondary">
                        {grant.resource}: {grant.actions.join('/')}
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
                      aria-label={`Delete role ${role.name}`}
                      onClick={() => setDeleting(role)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
            void queryClient.invalidateQueries({ queryKey: ['roles'] });
          }}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete role"
        description={`Delete role "${deleting?.name ?? ''}"? Users holding it lose its permissions.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => {
          if (deleting) del.mutate(deleting.id);
        }}
      />
    </div>
  );
}
Roles.displayName = 'Roles';

// --- Editor dialog ---------------------------------------------------------

function RoleDialog({
  role,
  onClose,
  onSaved,
}: {
  role: Role | null;
  onClose: () => void;
  onSaved: () => void;
}) {
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
    onSuccess: () => {
      toast.success(role ? 'Role updated' : 'Role created');
      onSaved();
    },
    onError: (error) =>
      toast.error(
        `Failed to save: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const toggleAction = (grantIndex: number, action: string) =>
    setGrants((prev) =>
      prev.map((grant, i) =>
        i === grantIndex
          ? {
              ...grant,
              actions: grant.actions.includes(action)
                ? grant.actions.filter((a) => a !== action)
                : [...grant.actions, action],
            }
          : grant,
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
          <Label htmlFor="role-name">Name</Label>
          <Input
            id="role-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={role?.is_system}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="role-description">Description</Label>
          <Input
            id="role-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label>Permissions</Label>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => setGrants((prev) => [...prev, { resource: '', actions: ['read'] }])}
            >
              <Plus className="h-3.5 w-3.5" /> Add grant
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {grants.map((grant, grantIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: grant rows have no id
              <div key={grantIndex} className="rounded-md border border-border p-2">
                <div className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="resource (object name or *)"
                    aria-label="Grant resource"
                    value={grant.resource}
                    onChange={(e) =>
                      setGrants((prev) =>
                        prev.map((g, i) =>
                          i === grantIndex ? { ...g, resource: e.target.value } : g,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove grant"
                    onClick={() => setGrants((prev) => prev.filter((_, i) => i !== grantIndex))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-xs">
                  {ALL_ACTIONS.map((action) => (
                    // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (renders a button role=checkbox)
                    <label key={action} className="flex cursor-pointer items-center gap-1.5">
                      <Checkbox
                        checked={grant.actions.includes(action)}
                        onCheckedChange={() => toggleAction(grantIndex, action)}
                        aria-label={`${action} on ${grant.resource || 'resource'}`}
                      />
                      {action}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
RoleDialog.displayName = 'RoleDialog';
