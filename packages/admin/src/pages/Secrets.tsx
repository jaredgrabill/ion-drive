import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Spinner,
} from '../components/ui';
import { ApiError, api } from '../lib/api';

export function Secrets() {
  const queryClient = useQueryClient();
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: () => api.listSecrets() });
  const [open, setOpen] = useState(false);

  const del = useMutation({
    mutationFn: (key: string) => api.deleteSecret(key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['secrets'] }),
  });

  if (secrets.isLoading) return <Spinner />;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Secrets</h1>
          <p className="text-sm text-muted-foreground">
            Encrypted at rest (AES-256-GCM). Values are never shown after saving.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add Secret
        </Button>
      </div>

      {(secrets.data ?? []).length === 0 ? (
        <EmptyState
          title="No secrets stored"
          hint="Add API tokens and credentials your building blocks need."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {(secrets.data ?? []).map((s) => (
                  <tr key={s.key} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">{s.key}</span>
                        <Badge variant="secondary">encrypted</Badge>
                      </div>
                      {s.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{s.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                      updated {new Date(s.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Delete secret"
                        onClick={() => confirm(`Delete secret "${s.key}"?`) && del.mutate(s.key)}
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
        <SecretDialog
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            queryClient.invalidateQueries({ queryKey: ['secrets'] });
          }}
        />
      )}
    </div>
  );
}

function SecretDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');

  const save = useMutation({
    mutationFn: () => api.setSecret(key.trim(), value, description || undefined),
    onSuccess: onSaved,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add Secret"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!key.trim() || !value || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Key</Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="STRIPE_API_KEY"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Value</Label>
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk_live_…"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Description</Label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
        {save.error && (
          <p className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : 'Failed to save secret'}
          </p>
        )}
      </div>
    </Dialog>
  );
}
