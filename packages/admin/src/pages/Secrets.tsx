/**
 * Secrets — encrypted key/value store management.
 *
 * Values are AES-256-GCM encrypted at rest and never shown after saving.
 * Deletion goes through an AlertDialog; mutations toast their outcome.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LockKeyhole, Plus, Trash2 } from 'lucide-react';
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
  Skeleton,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';

export function Secrets() {
  const queryClient = useQueryClient();
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: () => api.listSecrets() });
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const del = useMutation({
    mutationFn: (key: string) => api.deleteSecret(key),
    onSuccess: () => {
      toast.success('Secret deleted');
      void queryClient.invalidateQueries({ queryKey: ['secrets'] });
    },
    onError: (error) =>
      toast.error(
        `Failed to delete: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Secrets</h1>
          <p className="text-sm text-muted-foreground">
            Encrypted at rest (AES-256-GCM). Values are never shown after saving.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Add Secret
        </Button>
      </div>

      {secrets.isLoading ? (
        <Skeleton className="h-40 w-full" aria-hidden />
      ) : (secrets.data ?? []).length === 0 ? (
        <EmptyState
          icon={<LockKeyhole className="h-8 w-8" />}
          title="No secrets stored"
          hint="Add API tokens and credentials your building blocks need."
          action={
            <Button size="sm" onClick={() => setOpen(true)}>
              Add Secret
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {(secrets.data ?? []).map((secret) => (
                  <tr key={secret.key} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">{secret.key}</span>
                        <Badge variant="secondary">encrypted</Badge>
                      </div>
                      {secret.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{secret.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                      updated {new Date(secret.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete secret ${secret.key}`}
                        onClick={() => setDeleting(secret.key)}
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
            void queryClient.invalidateQueries({ queryKey: ['secrets'] });
          }}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete secret"
        description={`Delete secret "${deleting ?? ''}"? Anything reading it will start failing.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => {
          if (deleting) del.mutate(deleting);
        }}
      />
    </div>
  );
}
Secrets.displayName = 'Secrets';

// --- Create dialog ---------------------------------------------------------

function SecretDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');

  const save = useMutation({
    mutationFn: () => api.setSecret(key.trim(), value, description || undefined),
    onSuccess: () => {
      toast.success('Secret saved');
      onSaved();
    },
    onError: (error) =>
      toast.error(
        `Failed to save: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
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
          <Label htmlFor="secret-key">Key</Label>
          <Input
            id="secret-key"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="STRIPE_API_KEY"
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="secret-value">Value</Label>
          <Input
            id="secret-value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk_live_…"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="secret-description">Description</Label>
          <Input
            id="secret-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>
    </Dialog>
  );
}
SecretDialog.displayName = 'SecretDialog';
