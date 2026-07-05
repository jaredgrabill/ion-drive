/**
 * Task persistence — definitions in `_ion_tasks`, execution history in
 * `_ion_task_runs`.
 *
 * {@link bootstrapTaskTables} creates both tables (idempotent, `IF NOT EXISTS`).
 * The store is a thin, typed data-access layer over Kysely; scheduling and
 * execution live in `scheduler.ts` / `task-runner.ts`.
 */

import { type Kysely, sql } from 'kysely';
import type { IonTask, IonTaskRun, SystemDatabase } from '../db/types.js';
import type { TaskInput, TaskPatch, TaskRunStatus, TaskTrigger } from './task-types.js';

/** Creates the task-engine system tables if absent. Safe to call repeatedly. */
export async function bootstrapTaskTables(db: Kysely<SystemDatabase>): Promise<void> {
  await db.schema
    .createTable('_ion_tasks')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('name', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('description', 'text')
    .addColumn('type', 'varchar(64)', (col) => col.notNull())
    .addColumn('schedule', 'varchar(255)')
    .addColumn('timezone', 'varchar(64)')
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('config', 'jsonb', (col) => col.notNull().defaultTo('{}'))
    .addColumn('last_run_at', 'timestamptz')
    .addColumn('last_status', 'varchar(20)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  await db.schema
    .createTable('_ion_task_runs')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('task_id', 'uuid', (col) =>
      col.notNull().references('_ion_tasks.id').onDelete('cascade'),
    )
    .addColumn('status', 'varchar(20)', (col) => col.notNull())
    .addColumn('trigger', 'varchar(20)', (col) => col.notNull())
    .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('finished_at', 'timestamptz')
    .addColumn('duration_ms', 'integer')
    .addColumn('result', 'jsonb')
    .addColumn('error', 'text')
    .execute();

  await db.schema
    .createIndex('_ion_task_runs_task_started_idx')
    .ifNotExists()
    .on('_ion_task_runs')
    .columns(['task_id', 'started_at'])
    .execute();
}

export class TaskStore {
  constructor(private readonly db: Kysely<SystemDatabase>) {}

  // --- Task definitions ---

  async list(): Promise<IonTask[]> {
    return this.db.selectFrom('_ion_tasks').selectAll().orderBy('name').execute();
  }

  async getById(id: string): Promise<IonTask | undefined> {
    return this.db.selectFrom('_ion_tasks').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async getByName(name: string): Promise<IonTask | undefined> {
    return this.db.selectFrom('_ion_tasks').selectAll().where('name', '=', name).executeTakeFirst();
  }

  /** Enabled tasks that have a cron schedule — the set the scheduler registers. */
  async listSchedulable(): Promise<IonTask[]> {
    return this.db
      .selectFrom('_ion_tasks')
      .selectAll()
      .where('enabled', '=', true)
      .where('schedule', 'is not', null)
      .execute();
  }

  async create(input: TaskInput): Promise<IonTask> {
    return this.db
      .insertInto('_ion_tasks')
      .values({
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        schedule: input.schedule ?? null,
        timezone: input.timezone ?? null,
        enabled: input.enabled ?? true,
        config: JSON.stringify(input.config ?? {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, patch: TaskPatch): Promise<IonTask | undefined> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.schedule !== undefined) set.schedule = patch.schedule;
    if (patch.timezone !== undefined) set.timezone = patch.timezone;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.config !== undefined) set.config = JSON.stringify(patch.config);

    return this.db
      .updateTable('_ion_tasks')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('_ion_tasks').where('id', '=', id).executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /** Records the outcome of the latest run onto the task definition. */
  async touch(id: string, lastRunAt: Date, lastStatus: TaskRunStatus): Promise<void> {
    await this.db
      .updateTable('_ion_tasks')
      .set({ last_run_at: lastRunAt, last_status: lastStatus, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  // --- Runs ---

  /** Opens a new run row in the `running` state and returns it. */
  async startRun(taskId: string, trigger: TaskTrigger): Promise<IonTaskRun> {
    return this.db
      .insertInto('_ion_task_runs')
      .values({ task_id: taskId, status: 'running', trigger })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Closes a run row with its terminal status, duration, and result/error. */
  async finishRun(
    runId: string,
    outcome: {
      status: Exclude<TaskRunStatus, 'running'>;
      durationMs: number;
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<void> {
    await this.db
      .updateTable('_ion_task_runs')
      .set({
        status: outcome.status,
        finished_at: sql`now()`,
        duration_ms: outcome.durationMs,
        result: outcome.result != null ? JSON.stringify(outcome.result) : null,
        error: outcome.error ?? null,
      })
      .where('id', '=', runId)
      .execute();
  }

  async listRuns(taskId: string, limit = 50): Promise<IonTaskRun[]> {
    return this.db
      .selectFrom('_ion_task_runs')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('started_at', 'desc')
      .limit(limit)
      .execute();
  }
}
