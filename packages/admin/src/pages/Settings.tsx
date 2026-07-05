import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  Input,
  Label,
  Select,
  Spinner,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { CreatedApiKey } from '../lib/types';

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Settings</h1>
      <ApiKeysSection />
    </div>
  );
}

function ApiKeysSection() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.listApiKeys() });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.listRoles() });
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>API Keys</CardTitle>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> New Key
        </Button>
      </CardHeader>
      <CardContent>
        {keys.isLoading ? (
          <Spinner />
        ) : (keys.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No API keys. Create one to let scripts or LLM agents authenticate.
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {(keys.data ?? []).map((k) => (
                <tr key={k.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2">
                    <div className="font-medium">{k.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">iond_{k.prefix}_…</div>
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {k.lastUsedAt
                      ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                      : 'never used'}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Revoke key"
                      onClick={() => confirm(`Revoke "${k.name}"?`) && revoke.mutate(k.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      {open && (
        <CreateKeyDialog
          roles={(roles.data ?? []).map((r) => ({ id: r.id, name: r.name }))}
          onClose={() => setOpen(false)}
          onCreated={(key) => {
            setOpen(false);
            setCreated(key);
            queryClient.invalidateQueries({ queryKey: ['api-keys'] });
          }}
        />
      )}

      {created && (
        <Dialog
          open
          onClose={() => setCreated(null)}
          title="API Key Created"
          footer={<Button onClick={() => setCreated(null)}>Done</Button>}
        >
          <p className="mb-2 text-sm text-muted-foreground">
            Copy this key now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-2">
            <code className="flex-1 break-all font-mono text-xs">{created.key}</code>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy"
              onClick={() => navigator.clipboard?.writeText(created.key)}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

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
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CI pipeline" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>
            Role{' '}
            <span className="font-normal text-xs text-muted-foreground">
              (grants this role's permissions)
            </span>
          </Label>
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">No role (no permissions)</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        {create.error && (
          <p className="text-sm text-destructive">
            {create.error instanceof ApiError ? create.error.message : 'Failed to create key'}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Use with header <code className="font-mono">X-API-Key</code> or{' '}
          <code className="font-mono">Authorization: Bearer</code>.
        </p>
      </div>
    </Dialog>
  );
}
