/**
 * TaskDetail — one task's configuration and run history.
 *
 * Shows the definition (type, schedule, next fire, config JSON editor with
 * save), a "Run Now" button (`POST /tasks/:id/run` → toast + history
 * refresh), and the recent run table (status badge, trigger, duration,
 * expandable result/error JSON). Delete lives behind an AlertDialog.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { format, formatDistanceToNow } from 'date-fns';
import { ArrowLeft, Play, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Skeleton,
  Switch,
  Textarea,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { TaskRun } from '../lib/types';

// --- Page --------------------------------------------------------------

export function TaskDetail() {
  const { id } = useParams({ from: '/tasks/$id' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [configDraft, setConfigDraft] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const task = useQuery({
    queryKey: ['task', id],
    queryFn: () => api.getTask(id),
    refetchInterval: 10_000,
  });

  // Seed the config editor once the task loads (and after external updates).
  useEffect(() => {
    if (task.data && configDraft === null) {
      setConfigDraft(JSON.stringify(task.data.config, null, 2));
    }
  }, [task.data, configDraft]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['task', id] });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };

  const run = useMutation({
    mutationFn: () => api.runTask(id),
    onSuccess: () => {
      toast.success('Run started');
      invalidate();
    },
    onError: (error) =>
      toast.error(
        `Failed to run: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const saveConfig = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(configDraft ?? '{}') as Record<string, unknown>;
      } catch {
        throw new ApiError('Config must be valid JSON', 400);
      }
      return api.updateTask(id, { config: parsed });
    },
    onSuccess: () => {
      toast.success('Config saved');
      invalidate();
    },
    onError: (error) =>
      toast.error(
        `Failed to save: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateTask(id, { enabled }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => api.deleteTask(id),
    onSuccess: () => {
      toast.success('Task deleted');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void navigate({ to: '/tasks' });
    },
    onError: (error) =>
      toast.error(
        `Failed to delete: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  if (task.isLoading) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4" aria-hidden>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (task.isError || !task.data) {
    return <p className="text-destructive">Task not found.</p>;
  }
  const t = task.data;

  return (
    <div className="mx-auto max-w-4xl">
      <button
        type="button"
        onClick={() => void navigate({ to: '/tasks' })}
        className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Tasks
      </button>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">{t.name}</h1>
          {t.description && <p className="text-sm text-muted-foreground">{t.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={t.enabled}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
            aria-label={t.enabled ? 'Disable task' : 'Enable task'}
          />
          <Button onClick={() => run.mutate()} disabled={run.isPending} className="gap-1.5">
            <Play className="h-4 w-4" /> Run Now
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label="Delete task"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Definition */}
      <Card className="mb-4">
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Handler</p>
            <Badge variant="outline" className="mt-1 font-mono">
              {t.type}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Schedule</p>
            <p className="mt-1 font-mono text-xs">{t.schedule ?? 'on demand'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Next run</p>
            <p className="mt-1 text-xs">
              {t.nextRun ? format(new Date(t.nextRun), 'MMM d, HH:mm:ss') : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Last status</p>
            <p className="mt-1">
              {t.last_status ? (
                <Badge variant={t.last_status === 'success' ? 'success' : 'destructive'}>
                  {t.last_status}
                </Badge>
              ) : (
                '—'
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Config editor */}
      <Card className="mb-4">
        <CardHeader className="flex-row items-center justify-between p-3">
          <CardTitle className="text-sm">Config</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => saveConfig.mutate()}
            disabled={saveConfig.isPending}
          >
            {saveConfig.isPending ? 'Saving…' : 'Save config'}
          </Button>
        </CardHeader>
        <CardContent className="p-3">
          <Label htmlFor="task-config-editor" className="sr-only">
            Task config JSON
          </Label>
          <Textarea
            id="task-config-editor"
            value={configDraft ?? ''}
            onChange={(e) => setConfigDraft(e.target.value)}
            rows={8}
            className="font-mono text-xs"
          />
        </CardContent>
      </Card>

      {/* Run history */}
      <Card>
        <CardHeader className="p-3">
          <CardTitle className="text-sm">Run history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {t.runs.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Trigger
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Duration
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Started
                  </th>
                </tr>
              </thead>
              <tbody>
                {t.runs.map((r: TaskRun) => (
                  <Fragment key={r.id}>
                    <tr
                      tabIndex={0}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => setExpandedRun(expandedRun === r.id ? null : r.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpandedRun(expandedRun === r.id ? null : r.id);
                        }
                      }}
                    >
                      <td className="px-4 py-2">
                        <Badge
                          variant={
                            r.status === 'success'
                              ? 'success'
                              : r.status === 'failed'
                                ? 'destructive'
                                : 'info'
                          }
                        >
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-xs">{r.trigger}</td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {r.duration_ms !== null ? `${r.duration_ms}ms` : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(r.started_at), { addSuffix: true })}
                      </td>
                    </tr>
                    {expandedRun === r.id && (
                      <tr className="border-b border-border/40 bg-surface-sunken last:border-0">
                        <td colSpan={4} className="px-4 py-3">
                          {r.error ? (
                            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-destructive">
                              {r.error}
                            </pre>
                          ) : (
                            <pre className="overflow-x-auto font-mono text-xs">
                              {JSON.stringify(r.result ?? {}, null, 2)}
                            </pre>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete task"
        description={`This will permanently delete "${t.name}" and its run history. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
TaskDetail.displayName = 'TaskDetail';
