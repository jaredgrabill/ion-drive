/**
 * Cron scheduler — fires task runs on a schedule using `croner`.
 *
 * On {@link TaskScheduler.start} (and every {@link TaskScheduler.reload}) it
 * reads the enabled, scheduled tasks from the store and (re)creates one croner
 * job per task. Jobs use croner's `protect` option so a slow run never overlaps
 * itself. Each fire re-reads the task from the store, so a job always runs with
 * the latest config even between reloads. The server calls `reload()` after any
 * task mutation so the schedule stays in sync without a restart.
 *
 * `croner` is a zero-dependency, DST-aware cron implementation; invalid cron
 * patterns throw at scheduling time and are surfaced back to the caller
 * (validated up front by the task routes).
 */

import { Cron } from 'croner';
import type { TaskRunner } from './task-runner.js';
import type { TaskStore } from './task-store.js';
import type { TaskLogger } from './task-types.js';

export class TaskScheduler {
  private readonly jobs = new Map<string, Cron>();
  private started = false;

  constructor(
    private readonly store: TaskStore,
    private readonly runner: TaskRunner,
    private readonly logger: TaskLogger,
  ) {}

  /** Validates a cron pattern without scheduling it. Returns an error message or null. */
  static validatePattern(pattern: string, timezone?: string | null): string | null {
    try {
      // Constructing with `paused` avoids side effects; we only want parse validation.
      new Cron(pattern, { paused: true, timezone: timezone ?? undefined }).stop();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Loads and schedules all enabled, scheduled tasks. */
  async start(): Promise<void> {
    this.started = true;
    await this.reload();
  }

  /** Reconciles the live cron jobs with the current set of scheduled tasks. */
  async reload(): Promise<void> {
    if (!this.started) return;
    this.stopAll();

    const tasks = await this.store.listSchedulable();
    for (const task of tasks) {
      if (!task.schedule) continue;
      try {
        const job = new Cron(
          task.schedule,
          { name: task.name, timezone: task.timezone ?? undefined, protect: true },
          () => this.fire(task.id),
        );
        this.jobs.set(task.id, job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to schedule task "${task.name}": ${message}`, {
          taskId: task.id,
        });
      }
    }
    this.logger.info(`Task scheduler active with ${this.jobs.size} scheduled task(s)`);
  }

  /** Fires a scheduled run, re-reading the task so config changes are picked up. */
  private async fire(taskId: string): Promise<void> {
    const task = await this.store.getById(taskId);
    if (!task || !task.enabled) return;
    try {
      await this.runner.run(task, 'schedule');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Scheduled run of "${task.name}" could not be recorded: ${message}`, {
        taskId,
      });
    }
  }

  /** The next scheduled fire time for a task, or null if not scheduled. */
  nextRun(taskId: string): Date | null {
    return this.jobs.get(taskId)?.nextRun() ?? null;
  }

  private stopAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** Stops all cron jobs (called on server shutdown). */
  stop(): void {
    this.started = false;
    this.stopAll();
  }
}
