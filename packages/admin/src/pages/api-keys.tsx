/**
 * ApiKeys — API key management (split out of Settings in Phase 8).
 *
 * Lists keys with prefix, role, and last-used; creates keys through a
 * dialog (role selection grants that role's permissions) and shows the
 * one-time reveal dialog with copy. Revoke goes through an AlertDialog.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { ApiKeyMetadata, CreatedApiKey } from '../lib/types';

// --- Page --------------------------------------------------------------

export function ApiKeys() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.listApiKeys() });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.listRoles() });
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyMetadata | null>(null);

  const roleName = (id: string | null) => (roles.data ?? []).find((r) => r.id === id)?.name;

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => {
      toast.success('API key revoked');
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (error) =>
      toast.error(
        `Failed to revoke: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground">
            Let scripts and LLM agents authenticate with{' '}
            <code className="font-mono text-xs">X-API-Key</code> or{' '}
            <code className="font-mono text-xs">Authorization: Bearer</code>.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> New Key
        </Button>
      </div>

      {keys.isLoading ? (
        <Skeleton className="h-48 w-full" aria-hidden />
      ) : (keys.data ?? []).length === 0 ? (
        <EmptyState
          icon={<KeyRound className="h-8 w-8" />}
          title="No API keys"
          hint="Create one to let scripts or LLM agents authenticate."
          action={
            <Button size="sm" onClick={() => setOpen(true)}>
              New Key
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Key
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Role
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Last used
                  </th>
                  <th scope="col" className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {(keys.data ?? []).map((key) => (
                  <tr key={key.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{key.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        iond_{key.prefix}_…
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {key.roleId ? (
                        <Badge variant="secondary">{roleName(key.roleId) ?? 'unknown'}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">none</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {key.lastUsedAt
                        ? formatDistanceToNow(new Date(key.lastUsedAt), { addSuffix: true })
                        : 'never'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Revoke ${key.name}`}
                        onClick={() => setRevoking(key)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {open && (
        <CreateKeyDialog
          roles={(roles.data ?? []).map((r) => ({ id: r.id, name: r.name }))}
          onClose={() => setOpen(false)}
          onCreated={(key) => {
            setOpen(false);
            setCreated(key);
            void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
          }}
        />
      )}

      {created && (
        <Dialog
          open
          onClose={() => setCreated(null)}
          title="API Key Created"
          description="Copy this key now — it will not be shown again."
          footer={<Button onClick={() => setCreated(null)}>Done</Button>}
        >
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken p-2">
            <code className="flex-1 break-all font-mono text-xs">{created.key}</code>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy key"
              onClick={() => {
                navigator.clipboard?.writeText(created.key);
                toast('Copied to clipboard');
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </Dialog>
      )}

      <AlertDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke API key"
        description={`"${revoking?.name ?? ''}" will stop working immediately. This cannot be undone.`}
        confirmLabel="Revoke"
        confirmVariant="destructive"
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id);
        }}
      />
    </div>
  );
}
ApiKeys.displayName = 'ApiKeys';

// --- Create dialog -------------------------------------------------------

function CreateKeyDialog({
  roles,
  onClose,
  onCreated,
}: {
  roles: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('');

  const create = useMutation({
    mutationFn: () => api.createApiKey({ name: name.trim(), roleId: roleId || undefined }),
    onSuccess: onCreated,
    onError: (error) =>
      toast.error(
        `Failed to create: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="New API Key"
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CI pipeline"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="key-role">
            Role{' '}
            <span className="font-normal text-xs text-muted-foreground">
              (grants this role's permissions)
            </span>
          </Label>
          <Select id="key-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">No role (no permissions)</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Dialog>
  );
}
CreateKeyDialog.displayName = 'CreateKeyDialog';
