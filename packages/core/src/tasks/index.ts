/**
 * Task engine (Phase 5) — public facade over the store, runner, and scheduler.
 *
 * {@link TaskEngine} is the single object the server wires in. It bootstraps the
 * task tables, validates task definitions (known handler type + valid cron
 * pattern + unique name), keeps the cron scheduler in sync on every mutation,
 * and exposes on-demand execution. All CRUD flows through here so the schedule
 * and the persisted definitions never drift.
 */

import type { Kysely } from 'kysely';
import type { IonTask, IonTaskRun, SystemDatabase } from '../db/types.js';
import { TaskScheduler } from './scheduler.js';
import { TaskRunner, type TaskRunnerOptions } from './task-runner.js';
import { TaskStore, bootstrapTaskTables } from './task-store.js';
import type {
  TaskHandler,
  TaskInput,
  TaskLogger,
  TaskPatch,
  TaskTrigger,
  TaskWithRuns,
} from './task-types.js';

/** Error codes map to HTTP statuses in the task routes. */
export type TaskErrorCode = 'validation' | 'not_found' | 'conflict';

export class TaskEngineError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskEngineError';
  }
}

export interface TaskEngineOptions {
  logger: TaskLogger;
  handlers?: TaskHandler[];
  defaultTimeoutMs?: number;
}

export class TaskEngine {
  readonly store: TaskStore;
  readonly runner: TaskRunner;
  readonly scheduler: TaskScheduler;
  private readonly logger: TaskLogger;

  constructor(
    private readonly db: Kysely<SystemDatabase>,
    options: TaskEngineOptions,
  ) {
    this.logger = options.logger;
    this.store = new TaskStore(db);
    const runnerOptions: TaskRunnerOptions = {
      logger: options.logger,
      defaultTimeoutMs: options.defaultTimeoutMs,
      handlers: options.handlers,
    };
    this.runner = new TaskRunner(this.store, runnerOptions);
    this.scheduler = new TaskScheduler(this.store, this.runner, this.logger);
  }

  /** Creates the task tables. Call once at boot before {@link start}. */
  async initialize(): Promise<void> {
    await bootstrapTaskTables(this.db);
  }

  /** Starts the cron scheduler. */
  async start(): Promise<void> {
    await this.scheduler.start();
  }

  /** Stops the cron scheduler (on shutdown). */
  stop(): void {
    this.scheduler.stop();
  }

  // --- Queries ---

  list(): Promise<IonTask[]> {
    return this.store.list();
  }

  getById(id: string): Promise<IonTask | undefined> {
    return this.store.getById(id);
  }

  listRuns(taskId: string, limit?: number): Promise<IonTaskRun[]> {
    return this.store.listRuns(taskId, limit);
  }

  listHandlers(): { type: string; description: string }[] {
    return this.runner.listHandlers();
  }

  /** A task plus its recent run history and next scheduled fire time. */
  async getWithRuns(
    id: string,
    runLimit = 20,
  ): Promise<(TaskWithRuns & { nextRun: Date | null }) | undefined> {
    const task = await this.store.getById(id);
    if (!task) return undefined;
    const runs = await this.store.listRuns(id, runLimit);
    return { ...task, runs, nextRun: this.scheduler.nextRun(id) };
  }

  // --- Mutations ---

  async create(input: TaskInput): Promise<IonTask> {
    this.validate(input, true);
    if (await this.store.getByName(input.name)) {
      throw new TaskEngineError('conflict', `A task named "${input.name}" already exists`);
    }
    const task = await this.store.create(input);
    await this.scheduler.reload();
    return task;
  }

  async update(id: string, patch: TaskPatch): Promise<IonTask> {
    const existing = await this.store.getById(id);
    if (!existing) throw new TaskEngineError('not_found', 'Task not found');
    this.validate({ ...existing, ...patch } as TaskInput, false);
    if (patch.name && patch.name !== existing.name && (await this.store.getByName(patch.name))) {
      throw new TaskEngineError('conflict', `A task named "${patch.name}" already exists`);
    }
    const updated = await this.store.update(id, patch);
    if (!updated) throw new TaskEngineError('not_found', 'Task not found');
    await this.scheduler.reload();
    return updated;
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.store.delete(id);
    if (!deleted) throw new TaskEngineError('not_found', 'Task not found');
    await this.scheduler.reload();
  }

  /** Runs a task immediately, returning the completed run record. */
  async runNow(id: string, trigger: TaskTrigger = 'manual'): Promise<IonTaskRun> {
    const task = await this.store.getById(id);
    if (!task) throw new TaskEngineError('not_found', 'Task not found');
    return this.runner.run(task, trigger);
  }

  /** Validates a task definition; throws {@link TaskEngineError} on failure. */
  private validate(input: TaskInput, requireType: boolean): void {
    if (input.name !== undefined && input.name.trim() === '') {
      throw new TaskEngineError('validation', 'Task name must not be empty');
    }
    if ((requireType || input.type !== undefined) && !this.runner.hasHandler(input.type)) {
      const known = this.runner
        .listHandlers()
        .map((h) => h.type)
        .join(', ');
      throw new TaskEngineError(
        'validation',
        `Unknown task type "${input.type}". Known types: ${known}`,
      );
    }
    if (input.schedule) {
      const error = TaskScheduler.validatePattern(input.schedule, input.timezone);
      if (error) {
        throw new TaskEngineError('validation', `Invalid cron schedule: ${error}`);
      }
    }
  }
}

export { TaskStore, bootstrapTaskTables } from './task-store.js';
export { TaskRunner } from './task-runner.js';
export { TaskScheduler } from './scheduler.js';
export type {
  TaskHandler,
  TaskContext,
  TaskInput,
  TaskPatch,
  TaskTrigger,
  TaskRunStatus,
  TaskHandlerResult,
  TaskLogger,
  TaskWithRuns,
} from './task-types.js';
