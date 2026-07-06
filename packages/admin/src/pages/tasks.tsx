/**
 * Tasks — scheduled/background task management (list + create).
 *
 * Wires the Phase 5 `/api/v1/tasks` endpoints into the console. The table
 * shows each task's name, handler type, cron schedule, enabled Switch
 * (PATCHes immediately), and last-run status. Rows link to the TaskDetail
 * page. The create dialog offers the registered handler types from
 * `GET /tasks/handlers` and validates lazily server-side (the engine
 * validates cron eagerly and returns 400s we surface as toasts).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import { CalendarClock, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  Switch,
  Textarea,
  toast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { TaskDef } from '../lib/types';

// --- Page --------------------------------------------------------------

export function Tasks() {
  const queryClient = useQueryClient();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api.listTasks() });
  const [creating, setCreating] = useState(false);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateTask(id, { enabled }),
    onSuccess: (_data, vars) => {
      toast.success(vars.enabled ? 'Task enabled' : 'Task disabled');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (error) =>
      toast.error(
        `Failed to update: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Scheduled and on-demand background work, run by the task engine.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> New Task
        </Button>
      </div>

      {tasks.isLoading ? (
        <div className="flex flex-col gap-2" aria-hidden>
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (tasks.data ?? []).length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-8 w-8" />}
          title="No tasks yet"
          hint="Create a task to run work on a cron schedule or on demand."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              New Task
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Type
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Schedule
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Last run
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Enabled
                </th>
              </tr>
            </thead>
            <tbody>
              {(tasks.data ?? []).map((task) => (
                <tr
                  key={task.id}
                  className="border-t border-border/60 transition-colors hover:bg-muted/40"
                >
                  <td className="px-4 py-3">
                    <Link
                      to="/tasks/$id"
                      params={{ id: task.id }}
                      className="font-medium hover:underline"
                    >
                      {task.name}
                    </Link>
                    {task.description && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {task.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="font-mono">
                      {task.type}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {task.schedule ?? <span className="text-muted-foreground">on demand</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <LastRun task={task} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Switch
                      checked={task.enabled}
                      onCheckedChange={(enabled) => toggle.mutate({ id: task.id, enabled })}
                      aria-label={`${task.enabled ? 'Disable' : 'Enable'} ${task.name}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateTaskDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['tasks'] });
          }}
        />
      )}
    </div>
  );
}
Tasks.displayName = 'Tasks';

// --- Pieces --------------------------------------------------------------

function LastRun({ task }: { task: TaskDef }) {
  if (!task.last_run_at) return <span>never</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {task.last_status && (
        <Badge variant={task.last_status === 'success' ? 'success' : 'destructive'}>
          {task.last_status}
        </Badge>
      )}
      {formatDistanceToNow(new Date(task.last_run_at), { addSuffix: true })}
    </span>
  );
}
LastRun.displayName = 'LastRun';

function CreateTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const handlers = useQuery({ queryKey: ['task-handlers'], queryFn: () => api.listTaskHandlers() });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('log');
  const [schedule, setSchedule] = useState('');
  const [config, setConfig] = useState('{}');

  const create = useMutation({
    mutationFn: () => {
      let parsedConfig: Record<string, unknown> = {};
      if (config.trim()) {
        try {
          parsedConfig = JSON.parse(config) as Record<string, unknown>;
        } catch {
          throw new ApiError('Config must be valid JSON', 400);
        }
      }
      return api.createTask({
        name: name.trim(),
        description: description || undefined,
        type,
        schedule: schedule.trim() || null,
        config: parsedConfig,
      });
    },
    onSuccess: () => {
      toast.success('Task created');
      onCreated();
    },
    onError: (error) =>
      toast.error(
        `Failed to create: ${error instanceof ApiError ? error.message : 'unexpected error'}`,
      ),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="New Task"
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
          <Label htmlFor="task-name">Name</Label>
          <Input
            id="task-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly cleanup"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-description">Description</Label>
          <Input
            id="task-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-type">Handler</Label>
            <Select id="task-type" value={type} onChange={(e) => setType(e.target.value)}>
              {(handlers.data ?? [{ type: 'log', description: '' }]).map((h) => (
                <option key={h.type} value={h.type}>
                  {h.type}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-schedule">
              Cron schedule{' '}
              <span className="font-normal text-xs text-muted-foreground">(blank = on demand)</span>
            </Label>
            <Input
              id="task-schedule"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="*/5 * * * *"
              className="font-mono"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-config">Config (JSON)</Label>
          <Textarea
            id="task-config"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={4}
            className="font-mono text-xs"
          />
        </div>
      </div>
    </Dialog>
  );
}
CreateTaskDialog.displayName = 'CreateTaskDialog';
