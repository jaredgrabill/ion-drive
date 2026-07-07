/**
 * Webhooks — outbound webhook management (Phase 12 / ADR-019).
 *
 * Lists webhooks with their topic patterns and enabled state; creates/edits
 * through a dialog (name, URL, comma-separated topic patterns); shows the
 * one-time signing-secret reveal after create (API-key style); per-row
 * actions: enable toggle, Send test, delete (AlertDialog). Delivery history
 * lives on the Events page filtered to `webhook:<id>`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Copy, Plus, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
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
  Switch,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { CreatedWebhook, Webhook, WebhookInput } from '../lib/types';

export function Webhooks() {
  const queryClient = useQueryClient();
  const webhooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.listWebhooks() });
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['webhooks'] });

  const toggle = useMutation({
    mutationFn: (hook: Webhook) => api.updateWebhook(hook.id, { enabled: !hook.enabled }),
    onSuccess: invalidate,
    onError: (error) => toast.error(errMessage('Failed to update', error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => {
      toast.success('Webhook deleted');
      invalidate();
    },
    onError: (error) => toast.error(errMessage('Failed to delete', error)),
  });

  const sendTest = useMutation({
    mutationFn: (id: string) => api.testWebhook(id),
    onSuccess: () => toast.success('Test event queued — check the Events page for the delivery'),
    onError: (error) => toast.error(errMessage('Test failed', error)),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground">
            Push matching bus events to external URLs, HMAC-signed with automatic retries.
          </p>
        </div>
        <Button onClick={() => setEditing('new')} className="gap-1.5">
          <Plus className="h-4 w-4" /> New Webhook
        </Button>
      </div>

      {webhooks.isLoading ? (
        <Skeleton className="h-48 w-full" aria-hidden />
      ) : (webhooks.data ?? []).length === 0 ? (
        <EmptyState
          icon={<WebhookIcon className="h-8 w-8" />}
          title="No webhooks"
          hint="Create one to push change events (data.contacts.*, data.#, …) to another system."
          action={
            <Button size="sm" onClick={() => setEditing('new')}>
              New Webhook
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
                    Webhook
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Topics
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Enabled
                  </th>
                  <th scope="col" className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {(webhooks.data ?? []).map((hook) => (
                  <tr key={hook.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => setEditing(hook)}
                      >
                        {hook.name}
                      </button>
                      <div className="max-w-sm truncate font-mono text-xs text-muted-foreground">
                        {hook.url}
                      </div>
                      {hook.managedBy !== 'user' && (
                        <Badge variant="secondary" className="mt-1">
                          {hook.managedBy}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {hook.topics.map((topic) => (
                          <Badge key={topic} variant="outline" className="font-mono text-[10px]">
                            {topic}
                          </Badge>
                        ))}
                      </div>
                      <Link
                        to="/events"
                        className="mt-1 inline-block text-xs text-muted-foreground hover:underline"
                      >
                        deliveries →
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Switch
                        checked={hook.enabled}
                        onCheckedChange={() => toggle.mutate(hook)}
                        aria-label={`${hook.enabled ? 'Disable' : 'Enable'} ${hook.name}`}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Send test to ${hook.name}`}
                        disabled={!hook.enabled || sendTest.isPending}
                        onClick={() => sendTest.mutate(hook.id)}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${hook.name}`}
                        onClick={() => setDeleting(hook)}
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

      {editing && (
        <WebhookDialog
          webhook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setEditing(null);
            invalidate();
            if (result && 'secret' in result) setCreated(result);
          }}
        />
      )}

      {created && (
        <Dialog
          open
          onClose={() => setCreated(null)}
          title="Webhook Created"
          description="Copy the signing secret now — it will not be shown again. Use it to verify the x-ion-signature header."
          footer={<Button onClick={() => setCreated(null)}>Done</Button>}
        >
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken p-2">
            <code className="flex-1 break-all font-mono text-xs">{created.secret}</code>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy secret"
              onClick={() => {
                navigator.clipboard?.writeText(created.secret);
                toast('Copied to clipboard');
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </Dialog>
      )}

      <AlertDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete webhook"
        description={`"${deleting?.name ?? ''}" will stop receiving events immediately. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </div>
  );
}
Webhooks.displayName = 'Webhooks';

// --- Create / edit dialog -------------------------------------------------

function WebhookDialog({
  webhook,
  onClose,
  onSaved,
}: {
  webhook: Webhook | null;
  onClose: () => void;
  onSaved: (created?: CreatedWebhook | Webhook | null) => void;
}) {
  const [name, setName] = useState(webhook?.name ?? '');
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [topicsText, setTopicsText] = useState(webhook?.topics.join(', ') ?? 'data.#');

  const topics = topicsText
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const valid = name.trim().length > 0 && /^https?:\/\//.test(url.trim()) && topics.length > 0;

  const save = useMutation({
    mutationFn: (): Promise<CreatedWebhook | Webhook | null> => {
      const input: WebhookInput = { name: name.trim(), url: url.trim(), topics };
      return webhook ? api.updateWebhook(webhook.id, input) : api.createWebhook(input);
    },
    onSuccess: (result) => {
      toast.success(webhook ? 'Webhook updated' : 'Webhook created');
      onSaved(result);
    },
    onError: (error) => toast.error(errMessage('Failed to save', error)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={webhook ? `Edit ${webhook.name}` : 'New Webhook'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending ? 'Saving…' : webhook ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hook-name">Name</Label>
          <Input
            id="hook-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="crm-to-slack"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hook-url">URL</Label>
          <Input
            id="hook-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/ion-events"
            className="font-mono text-xs"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hook-topics">
            Topic patterns{' '}
            <span className="font-normal text-xs text-muted-foreground">
              (comma-separated; `*` one segment, `#` many)
            </span>
          </Label>
          <Input
            id="hook-topics"
            value={topicsText}
            onChange={(e) => setTopicsText(e.target.value)}
            placeholder="data.contacts.*, data.orders.created"
            className="font-mono text-xs"
          />
        </div>
      </div>
    </Dialog>
  );
}
WebhookDialog.displayName = 'WebhookDialog';

function errMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof ApiError ? error.message : 'unexpected error'}`;
}
