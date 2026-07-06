/**
 * Task runner — executes a task through its handler and records the run.
 *
 * A small **handler registry** maps `IonTask.type` to behaviour. Three handlers
 * ship built in:
 *  - `noop` — does nothing (useful as a heartbeat / scheduling smoke test)
 *  - `log` — emits a log line (config: `{ message?, level? }`)
 *  - `http_request` — calls a URL (config: `{ url, method?, headers?, body?, timeoutMs? }`)
 *
 * {@link TaskRunner.run} opens a run row, invokes the handler under a timeout/
 * abort, then closes the run with its status, duration, and result/error. It
 * also emits an OpenTelemetry span and the `ion.task.*` metrics, keeping tasks
 * observable alongside the API surfaces.
 */

import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IonTask, IonTaskRun } from '../db/types.js';
import { recordTaskRun } from '../telemetry/metrics.js';
import { ION_ATTR } from '../telemetry/span-attributes.js';
import type { TaskStore } from './task-store.js';
import type {
  TaskContext,
  TaskHandler,
  TaskHandlerResult,
  TaskLogger,
  TaskTrigger,
} from './task-types.js';

const TRACER_NAME = '@ion-drive/core';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Result payloads are truncated to keep the history table small. */
const MAX_RESULT_BYTES = 8_192;

// --- Built-in handlers ---

const noopHandler: TaskHandler = {
  type: 'noop',
  description: 'Does nothing; useful as a scheduling heartbeat.',
  async run() {
    return { ok: true };
  },
};

const logHandler: TaskHandler = {
  type: 'log',
  description: 'Emits a log line. config: { message?: string, level?: info|warn|error }',
  async run(ctx) {
    const config = ctx.task.config as { message?: string; level?: string };
    const message = config.message ?? `Task "${ctx.task.name}" executed`;
    const level = config.level === 'warn' || config.level === 'error' ? config.level : 'info';
    ctx.logger[level](message, { task: ctx.task.name });
    return { logged: message, level };
  },
};

const httpRequestHandler: TaskHandler = {
  type: 'http_request',
  description: 'Performs an HTTP request. config: { url, method?, headers?, body?, timeoutMs? }',
  async run(ctx) {
    const config = ctx.task.config as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    };
    if (!config.url || typeof config.url !== 'string') {
      throw new Error('http_request task requires a string "url" in config');
    }
    const method = (config.method ?? 'GET').toUpperCase();
    const hasBody = config.body !== undefined && method !== 'GET' && method !== 'HEAD';
    const response = await fetch(config.url, {
      method,
      headers: config.headers,
      body: hasBody
        ? typeof config.body === 'string'
          ? config.body
          : JSON.stringify(config.body)
        : undefined,
      signal: ctx.signal,
    });
    // Drain the body so the connection is released; keep a short preview.
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${config.url}`);
    }
    return {
      status: response.status,
      ok: response.ok,
      bodyPreview: text.slice(0, 512),
    };
  },
};

const BUILT_IN_HANDLERS = [noopHandler, logHandler, httpRequestHandler];

export interface TaskRunnerOptions {
  logger: TaskLogger;
  /** Fallback timeout when a task's config does not specify `timeoutMs`. */
  defaultTimeoutMs?: number;
  /** Extra handlers to register on top of the built-ins. */
  handlers?: TaskHandler[];
}

export class TaskRunner {
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly logger: TaskLogger;
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly store: TaskStore,
    options: TaskRunnerOptions,
  ) {
    this.logger = options.logger;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (const handler of [...BUILT_IN_HANDLERS, ...(options.handlers ?? [])]) {
      this.handlers.set(handler.type, handler);
    }
  }

  /** Registers (or replaces) a handler by its `type`. */
  registerHandler(handler: TaskHandler): void {
    this.handlers.set(handler.type, handler);
  }

  /** Lists the registered handler types with their descriptions. */
  listHandlers(): { type: string; description: string }[] {
    return [...this.handlers.values()].map((h) => ({ type: h.type, description: h.description }));
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  /**
   * Executes a task once and records the run. Never throws for handler
   * failures — the failure is captured on the run row and returned; it only
   * rejects if opening the run row itself fails.
   */
  async run(task: IonTask, trigger: TaskTrigger): Promise<IonTaskRun> {
    const run = await this.store.startRun(task.id, trigger);
    const handler = this.handlers.get(task.type);
    const startNs = process.hrtime.bigint();
    const tracer = trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(`task ${task.name}`, {
      attributes: {
        [ION_ATTR.TASK_ID]: task.id,
        [ION_ATTR.TASK_NAME]: task.name,
        [ION_ATTR.TASK_TYPE]: task.type,
        [ION_ATTR.TASK_TRIGGER]: trigger,
      },
    });

    const timeoutMs = (task.config as { timeoutMs?: number }).timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Task timed out')), timeoutMs);

    let status: 'success' | 'failed' = 'success';
    let result: TaskHandlerResult = undefined;
    let error: string | undefined;

    try {
      if (!handler) {
        throw new Error(`No handler registered for task type "${task.type}"`);
      }
      const ctx: TaskContext = {
        task,
        runId: run.id,
        trigger,
        signal: controller.signal,
        logger: this.logger,
      };
      result = await this.race(handler.run(ctx), controller.signal, timeoutMs);
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : new Error(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      this.logger.error(`Task "${task.name}" failed: ${error}`, { taskId: task.id });
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    span.setAttribute(ION_ATTR.OUTCOME, status);
    span.end();

    const resultPayload = this.truncateResult(result);
    await this.store.finishRun(run.id, {
      status,
      durationMs: Math.round(durationMs),
      result: resultPayload,
      error: error ?? null,
    });
    await this.store.touch(task.id, new Date(), status);

    recordTaskRun(durationMs, {
      [ION_ATTR.TASK_NAME]: task.name,
      [ION_ATTR.TASK_TYPE]: task.type,
      [ION_ATTR.TASK_TRIGGER]: trigger,
      [ION_ATTR.OUTCOME]: status,
    });

    return {
      ...run,
      status,
      finished_at: new Date(),
      duration_ms: Math.round(durationMs),
      result: resultPayload,
      error: error ?? null,
    };
  }

  /** Races a handler promise against its abort/timeout. */
  private async race<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('Task aborted'));
        signal.addEventListener(
          'abort',
          () => reject(new Error(`Task exceeded ${timeoutMs}ms timeout`)),
          { once: true },
        );
      }),
    ]);
  }

  /** Ensures the stored result is an object and within the size budget. */
  private truncateResult(result: TaskHandlerResult): Record<string, unknown> | null {
    if (result == null) return null;
    const serialized = JSON.stringify(result);
    if (serialized.length <= MAX_RESULT_BYTES) return result as Record<string, unknown>;
    return { truncated: true, preview: serialized.slice(0, MAX_RESULT_BYTES) };
  }
}
