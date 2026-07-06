/**
 * Action executor (Phase 14, ADR-018) — runs a block's registered action or
 * hook handler with full platform context, under a timeout, with telemetry.
 *
 * This is the single invocation path shared by every surface:
 *  - REST:  `POST /api/v1/blocks/:block/actions/:action` (api/block-routes.ts)
 *  - MCP:   the `<block>_<action>` tools (mcp/server.ts)
 *  - hooks: `ALL /api/v1/hooks/:block/:hook` (api/hook-routes.ts)
 *
 * Execution contract (mirrors the task runner — extend, don't invent):
 *  1. the block must be *installed* and the action/hook *declared* in its
 *     manifest — the manifest is the source of truth for the public surface;
 *  2. the handler must be *registered* in the {@link ActionRegistry} by the
 *     block's vendored code (loaded via the plugin host);
 *  3. input is validated against the handler's Zod schema (400 on failure);
 *  4. the handler runs under an abort/timeout with an OTel span and
 *     `ion.action.*` / `ion.hook.*` metrics (parity with `ion.task.*`).
 */

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';
import type { AuthPrincipal } from '../auth/types.js';
import type { IonDriveConfig, SecretsManager } from '../config/index.js';
import type { DataService } from '../data/data-service.js';
import type { LoggerProvider } from '../logging/logger-provider.js';
import { recordActionRun, recordHookDelivery } from '../telemetry/metrics.js';
import { ION_ATTR } from '../telemetry/span-attributes.js';
import type {
  ActionContext,
  ActionDefinition,
  ActionRbac,
  ActionRegistry,
  HookContext,
  HookDefinition,
  HookResult,
} from './action-registry.js';
import type { BlockManifest, InstalledBlock } from './block-types.js';

const TRACER_NAME = '@ion-drive/core';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Error codes map to HTTP statuses in the routes (see api/block-routes.ts). */
export type ActionErrorCode = 'not_found' | 'validation' | 'timeout' | 'failed';

export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
    /** Per-field validation issues, when code is `validation`. */
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

/** The manifest-declared shape of an action (docs + RBAC live here). */
export interface DeclaredAction {
  block: string;
  name: string;
  description?: string;
  /** JSON-Schema-ish input description from the manifest (docs surfaces). */
  input?: Record<string, unknown>;
  rbac?: ActionRbac;
}

export interface ActionExecutorDeps {
  registry: ActionRegistry;
  /** Ledger lookup — an action is only reachable while its block is installed. */
  getInstalledBlock: (name: string) => Promise<InstalledBlock | undefined>;
  listInstalledBlocks: () => Promise<InstalledBlock[]>;
  dataService: DataService;
  secrets: SecretsManager;
  config: IonDriveConfig;
  logger: LoggerProvider;
}

/** Inbound webhook delivery details handed to `executeHook`. */
export interface HookDelivery {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  rawBody: Buffer;
}

export class ActionExecutor {
  constructor(private readonly deps: ActionExecutorDeps) {}

  /**
   * Resolves the RBAC requirement for invoking an action: the manifest's
   * per-action override, else `update` on the `blocks` resource. Throws
   * `not_found` if the block/action is not installed+declared+registered —
   * callers get a single resolution step before enforcement.
   */
  async resolveAction(
    block: string,
    action: string,
  ): Promise<{ definition: ActionDefinition; rbac: Required<ActionRbac> }> {
    const installed = await this.deps.getInstalledBlock(block);
    if (!installed || installed.status !== 'installed') {
      throw new ActionError('not_found', `Block "${block}" is not installed`);
    }
    const declared = (installed.manifest.actions ?? []).find((a) => a.name === action);
    if (!declared) {
      throw new ActionError('not_found', `Block "${block}" does not declare an action "${action}"`);
    }
    const definition = this.deps.registry.getAction(block, action);
    if (!definition) {
      throw new ActionError(
        'not_found',
        `Action "${block}.${action}" is declared but its handler is not registered — is the block's code vendored and loaded? (expected in /blocks/${block})`,
      );
    }
    return {
      definition,
      rbac: {
        resource: declared.rbac?.resource ?? definition.rbac?.resource ?? 'blocks',
        action: declared.rbac?.action ?? definition.rbac?.action ?? 'update',
      },
    };
  }

  /** The registered handler definition, if the block's code registered one. */
  getRegisteredAction(block: string, action: string): ActionDefinition | undefined {
    return this.deps.registry.getAction(block, action);
  }

  /** Lists every action declared by installed blocks (the docs surfaces read this). */
  async listDeclaredActions(): Promise<DeclaredAction[]> {
    const installed = await this.deps.listInstalledBlocks();
    return installed
      .filter((b) => b.status === 'installed')
      .flatMap((b) =>
        (b.manifest.actions ?? []).map((a) => ({
          block: b.name,
          name: a.name,
          description: a.description,
          input: a.input,
          rbac: a.rbac,
        })),
      );
  }

  /** Lists every hook declared by installed blocks (the docs surfaces read this). */
  async listDeclaredHooks(): Promise<
    { block: string; hook: NonNullable<BlockManifest['hooks']>[number] }[]
  > {
    const installed = await this.deps.listInstalledBlocks();
    return installed
      .filter((b) => b.status === 'installed')
      .flatMap((b) => (b.manifest.hooks ?? []).map((hook) => ({ block: b.name, hook })));
  }

  /**
   * Validates input and runs an action handler. `definition` comes from
   * {@link resolveAction} (so RBAC was already enforceable by the caller).
   */
  async executeAction(
    definition: ActionDefinition,
    rawInput: unknown,
    auth: AuthPrincipal | null,
  ): Promise<unknown> {
    const input = this.validateInput(definition, rawInput);
    const { block, name } = definition;
    return this.runWithTelemetry({
      spanName: `action ${block}.${name}`,
      attributes: { [ION_ATTR.BLOCK]: block, [ION_ATTR.ACTION]: name },
      timeoutMs: definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      record: recordActionRun,
      run: (signal) => {
        const ctx: ActionContext = {
          block,
          action: name,
          input,
          dataService: this.deps.dataService,
          secrets: this.deps.secrets,
          config: this.deps.config,
          logger: this.deps.logger.child({ block, action: name }),
          auth,
          signal,
        };
        return definition.handler(ctx);
      },
    });
  }

  /**
   * Resolves and runs a hook handler for an inbound webhook delivery. Hooks
   * are declared in the manifest (`hooks: [{ name }]`) and registered by
   * vendored code, exactly like actions.
   */
  async executeHook(
    block: string,
    hook: string,
    delivery: HookDelivery,
  ): Promise<Required<HookResult>> {
    const definition = await this.resolveHook(block, hook);
    const result = await this.runWithTelemetry({
      spanName: `hook ${block}.${hook}`,
      attributes: { [ION_ATTR.BLOCK]: block, [ION_ATTR.HOOK]: hook },
      timeoutMs: definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      record: recordHookDelivery,
      run: (signal) => {
        const ctx: HookContext = {
          block,
          hook,
          method: delivery.method,
          headers: delivery.headers,
          query: delivery.query,
          rawBody: delivery.rawBody,
          dataService: this.deps.dataService,
          secrets: this.deps.secrets,
          config: this.deps.config,
          logger: this.deps.logger.child({ block, hook }),
          signal,
        };
        return definition.handler(ctx);
      },
    });
    const hookResult = (result ?? {}) as HookResult;
    return { status: hookResult.status ?? 200, body: hookResult.body ?? { received: true } };
  }

  private async resolveHook(block: string, hook: string): Promise<HookDefinition> {
    const installed = await this.deps.getInstalledBlock(block);
    if (!installed || installed.status !== 'installed') {
      throw new ActionError('not_found', `Block "${block}" is not installed`);
    }
    const declared = (installed.manifest.hooks ?? []).find((h) => h.name === hook);
    if (!declared) {
      throw new ActionError('not_found', `Block "${block}" does not declare a hook "${hook}"`);
    }
    const definition = this.deps.registry.getHook(block, hook);
    if (!definition) {
      throw new ActionError(
        'not_found',
        `Hook "${block}.${hook}" is declared but its handler is not registered — is the block's code vendored and loaded? (expected in /blocks/${block})`,
      );
    }
    return definition;
  }

  /** Validates the raw body against the registered Zod schema (when present). */
  private validateInput(definition: ActionDefinition, rawInput: unknown): Record<string, unknown> {
    const candidate = rawInput ?? {};
    if (!definition.input) {
      if (typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new ActionError('validation', 'Action input must be a JSON object');
      }
      return candidate as Record<string, unknown>;
    }
    const parsed = definition.input.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => {
        const path = i.path.join('.');
        return path ? `${path}: ${i.message}` : i.message;
      });
      throw new ActionError(
        'validation',
        `Invalid input for "${definition.block}.${definition.name}": ${issues.join('; ')}`,
        issues,
      );
    }
    return parsed.data as Record<string, unknown>;
  }

  /** Shared span + metric + abort/timeout envelope for actions and hooks. */
  private async runWithTelemetry<T>(options: {
    spanName: string;
    attributes: Record<string, string>;
    timeoutMs: number;
    record: (durationMs: number, attributes: Record<string, string>) => void;
    run: (signal: AbortSignal) => Promise<T> | T;
  }): Promise<T> {
    const span = trace
      .getTracer(TRACER_NAME)
      .startSpan(options.spanName, { attributes: options.attributes });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const startNs = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'success';
    try {
      return await Promise.race([
        Promise.resolve(options.run(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () =>
              reject(new ActionError('timeout', `Handler exceeded ${options.timeoutMs}ms timeout`)),
            { once: true },
          );
        }),
      ]);
    } catch (err) {
      outcome = 'failed';
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      if (err instanceof ActionError) throw err;
      throw new ActionError('failed', error.message);
    } finally {
      clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      span.setAttribute(ION_ATTR.OUTCOME, outcome);
      span.end();
      options.record(durationMs, { ...options.attributes, [ION_ATTR.OUTCOME]: outcome });
    }
  }
}

/** Convenience: derives the MCP tool parameter shape from a registered action. */
export function mcpShapeForAction(definition: ActionDefinition | undefined): z.ZodRawShape {
  if (definition?.input instanceof z.ZodObject) {
    return (definition.input as z.ZodObject<z.ZodRawShape>).shape;
  }
  // No (object) schema registered — accept an opaque payload under `input`.
  return { input: z.record(z.unknown()).optional().describe('Raw action input payload') };
}

// Re-export the manifest action type for surface generators.
export type ManifestAction = NonNullable<BlockManifest['actions']>[number];
