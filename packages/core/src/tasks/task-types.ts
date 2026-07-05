/**
 * Type definitions for the Ion Drive task engine (Phase 5).
 *
 * A **task** is a named, optionally cron-scheduled unit of background work. Its
 * behaviour is provided by a **task handler** keyed by the task's `type`; the
 * handler receives the task's stored `config` plus a {@link TaskContext} and
 * returns a JSON-serialisable {@link TaskHandlerResult}. Each execution is
 * recorded as a **task run** for history/observability.
 *
 * The layering mirrors the schema engine: `task-store` persists definitions and
 * runs, `task-runner` executes a task through its handler, and `scheduler`
 * fires runs on a cron cadence. Nothing here imports Fastify — the engine is a
 * plain service wired into the server.
 */

import type { IonTask, IonTaskRun } from '../db/types.js';

export type { IonTask, IonTaskRun };

/** How a run was initiated. */
export type TaskTrigger = 'schedule' | 'manual';

/** Terminal status of a run (a run starts as `running`). */
export type TaskRunStatus = 'running' | 'success' | 'failed';

/** Input for creating a task definition. */
export interface TaskInput {
  name: string;
  description?: string | null;
  type: string;
  /** Cron expression (croner syntax); omit/null for on-demand-only tasks. */
  schedule?: string | null;
  timezone?: string | null;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Partial update for a task definition. */
export type TaskPatch = Partial<TaskInput>;

/**
 * Runtime context handed to a task handler. `signal` aborts when the run
 * exceeds its timeout; `logger` writes to the platform log; `runId`/`task`
 * identify the current execution.
 */
export interface TaskContext {
  task: IonTask;
  runId: string;
  trigger: TaskTrigger;
  signal: AbortSignal;
  logger: TaskLogger;
}

export interface TaskLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/** A JSON-serialisable summary a handler returns on success. */
export type TaskHandlerResult = Record<string, unknown> | undefined;

/** A pluggable unit of task behaviour, selected by `IonTask.type`. */
export interface TaskHandler {
  /** Discriminator matched against `IonTask.type`. */
  readonly type: string;
  /** Human-readable description surfaced in the API/console. */
  readonly description: string;
  /** Executes the task. Throw to mark the run failed. */
  run(ctx: TaskContext): Promise<TaskHandlerResult>;
}

/** A task with its recent run history attached (for detail views). */
export interface TaskWithRuns extends IonTask {
  runs: IonTaskRun[];
}
