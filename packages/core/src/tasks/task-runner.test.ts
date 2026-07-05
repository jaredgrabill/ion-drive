import { describe, expect, it, vi } from 'vitest';
import type { IonTask, IonTaskRun } from '../db/types.js';
import { TaskRunner } from './task-runner.js';
import type { TaskStore } from './task-store.js';
import type { TaskHandler, TaskLogger } from './task-types.js';

/** A task definition with sensible defaults for tests. */
function makeTask(overrides: Partial<IonTask> = {}): IonTask {
  return {
    id: overrides.id ?? 'task_1',
    name: overrides.name ?? 'test-task',
    description: null,
    type: overrides.type ?? 'noop',
    schedule: null,
    timezone: null,
    enabled: true,
    config: overrides.config ?? {},
    last_run_at: null,
    last_status: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as IonTask;
}

/** In-memory TaskStore double capturing the runner's writes. */
function fakeStore() {
  const finished: { runId: string; outcome: Record<string, unknown> }[] = [];
  const touched: { id: string; status: string }[] = [];
  let seq = 0;
  const store = {
    startRun: vi.fn(async (taskId: string, trigger: string): Promise<IonTaskRun> => {
      seq += 1;
      return {
        id: `run_${seq}`,
        task_id: taskId,
        status: 'running',
        trigger,
        started_at: new Date(),
        finished_at: null,
        duration_ms: null,
        result: null,
        error: null,
      };
    }),
    finishRun: vi.fn(async (runId: string, outcome: Record<string, unknown>) => {
      finished.push({ runId, outcome });
    }),
    touch: vi.fn(async (id: string, _at: Date, status: string) => {
      touched.push({ id, status });
    }),
  } as unknown as TaskStore;
  return { store, finished, touched };
}

const silentLogger: TaskLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe('TaskRunner', () => {
  it('runs the built-in noop handler successfully', async () => {
    const { store, finished, touched } = fakeStore();
    const runner = new TaskRunner(store, { logger: silentLogger });

    const run = await runner.run(makeTask({ type: 'noop' }), 'manual');

    expect(run.status).toBe('success');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.outcome.status).toBe('success');
    expect(touched[0]).toEqual({ id: 'task_1', status: 'success' });
  });

  it('runs the log handler and captures its result', async () => {
    const { store, finished } = fakeStore();
    const logs: string[] = [];
    const runner = new TaskRunner(store, {
      logger: { ...silentLogger, info: (m) => logs.push(m) },
    });

    const run = await runner.run(
      makeTask({ type: 'log', config: { message: 'hello world', level: 'info' } }),
      'schedule',
    );

    expect(run.status).toBe('success');
    expect(logs).toContain('hello world');
    expect(finished[0]?.outcome.result).toMatchObject({ logged: 'hello world', level: 'info' });
  });

  it('marks a run failed when the handler type is unknown', async () => {
    const { store, finished, touched } = fakeStore();
    const runner = new TaskRunner(store, { logger: silentLogger });

    const run = await runner.run(makeTask({ type: 'does_not_exist' }), 'manual');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('No handler registered');
    expect(finished[0]?.outcome.status).toBe('failed');
    expect(touched[0]?.status).toBe('failed');
  });

  it('captures a thrown handler error on the run', async () => {
    const { store } = fakeStore();
    const boom: TaskHandler = {
      type: 'boom',
      description: 'always throws',
      run: async () => {
        throw new Error('kaboom');
      },
    };
    const runner = new TaskRunner(store, { logger: silentLogger, handlers: [boom] });

    const run = await runner.run(makeTask({ type: 'boom' }), 'manual');

    expect(run.status).toBe('failed');
    expect(run.error).toBe('kaboom');
  });

  it('fails an http_request task with no url', async () => {
    const { store } = fakeStore();
    const runner = new TaskRunner(store, { logger: silentLogger });

    const run = await runner.run(makeTask({ type: 'http_request', config: {} }), 'manual');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('url');
  });

  it('registers custom handlers and lists them alongside the built-ins', () => {
    const { store } = fakeStore();
    const runner = new TaskRunner(store, {
      logger: silentLogger,
      handlers: [{ type: 'custom', description: 'x', run: async () => ({}) }],
    });

    const types = runner.listHandlers().map((h) => h.type);
    expect(types).toEqual(expect.arrayContaining(['noop', 'log', 'http_request', 'custom']));
    expect(runner.hasHandler('custom')).toBe(true);
    expect(runner.hasHandler('nope')).toBe(false);
  });
});
