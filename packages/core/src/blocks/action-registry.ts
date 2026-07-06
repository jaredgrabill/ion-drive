/**
 * Action + hook registry (Phase 14, ADR-018) — the seam between a block's
 * *vendored code* and the platform runtime.
 *
 * A logic-bearing block ships TypeScript that lives in the user's project
 * (`/blocks/<name>/`). That code is loaded through the plugin host and, in its
 * plugin `setup`, registers **named handlers** here:
 *
 *  - an **action** is a callable operation exposed at
 *    `POST /api/v1/blocks/:block/actions/:action` (and as an MCP tool) —
 *    e.g. `invoicing.create_payment_link`;
 *  - a **hook** is an inbound webhook endpoint at
 *    `ALL /api/v1/hooks/:block/:hook` that receives the *raw* request body so
 *    the handler can verify provider signatures (Stripe-style).
 *
 * The registry only *stores* definitions — registration happens early (during
 * plugin setup, before most services exist), while execution context
 * (DataService, secrets, config, …) is injected per invocation by the
 * {@link ActionExecutor}. The block installer consults this registry at install
 * time: a manifest that declares an action whose handler is not registered
 * fails with an actionable "did you vendor its code?" error.
 */

import type { z } from 'zod';
import type { Action } from '../auth/rbac/policy-types.js';
import type { AuthPrincipal } from '../auth/types.js';
import type { IonDriveConfig, SecretsManager } from '../config/index.js';
import type { DataService } from '../data/data-service.js';
import type { LoggerProvider } from '../logging/logger-provider.js';
import { serviceToken } from '../runtime/service-registry.js';

/** RBAC requirement for invoking an action (defaults: `update` on `blocks`). */
export interface ActionRbac {
  resource?: string;
  action?: Action;
}

/** The capabilities handed to an action handler per invocation. */
export interface ActionContext {
  /** The block the action belongs to. */
  block: string;
  /** The action name. */
  action: string;
  /** The validated input payload (validated by the registered `input` schema when present). */
  input: Record<string, unknown>;
  /** CRUD against the platform's data objects. */
  dataService: DataService;
  /** Encrypted platform secrets (e.g. a Stripe API key). */
  secrets: SecretsManager;
  /** The validated server configuration. */
  config: IonDriveConfig;
  /** Logger tagged with the block + action. */
  logger: LoggerProvider;
  /** The authenticated principal, when the request carried one. */
  auth: AuthPrincipal | null;
  /** Aborts when the invocation times out — pass to fetch etc. */
  signal: AbortSignal;
}

/** A registered action — the callable surface of a vendored-logic block. */
export interface ActionDefinition {
  /** The owning block's name (must match the manifest's `name`). */
  block: string;
  /** Action name, e.g. `create_payment_link`. */
  name: string;
  description?: string;
  /**
   * Zod schema validating the request body. Use a `z.object(...)` — its shape
   * is also reflected as the MCP tool's parameters. When omitted, any JSON
   * object is passed through.
   */
  input?: z.ZodTypeAny;
  /** RBAC override; default requires `update` on the `blocks` resource. */
  rbac?: ActionRbac;
  /** Per-invocation timeout (default 30s). */
  timeoutMs?: number;
  handler: (ctx: ActionContext) => Promise<unknown>;
}

/** The capabilities handed to a hook handler per delivery. */
export interface HookContext {
  block: string;
  hook: string;
  /** HTTP method of the inbound delivery. */
  method: string;
  /** Request headers (lower-cased names) — where provider signatures live. */
  headers: Record<string, string | string[] | undefined>;
  /** Query-string parameters. */
  query: Record<string, unknown>;
  /**
   * The raw, unparsed request body. Signature schemes (Stripe, GitHub, …) sign
   * the exact bytes, so parse JSON only *after* verification.
   */
  rawBody: Buffer;
  dataService: DataService;
  secrets: SecretsManager;
  config: IonDriveConfig;
  logger: LoggerProvider;
  signal: AbortSignal;
}

/** What a hook handler returns — mapped onto the HTTP response. */
export interface HookResult {
  /** HTTP status (default 200). */
  status?: number;
  /** JSON response body (default `{ received: true }`). */
  body?: unknown;
}

/** A registered inbound-webhook handler. */
export interface HookDefinition {
  block: string;
  /** Hook name, e.g. `stripe` → `/api/v1/hooks/invoicing/stripe`. */
  name: string;
  description?: string;
  /** Per-delivery timeout (default 30s). */
  timeoutMs?: number;
  /** May return nothing — the route then responds `200 { received: true }`. */
  // biome-ignore lint/suspicious/noConfusingVoidType: handlers that respond with the default need no return statement — requiring `return undefined` would hurt vendored-code ergonomics.
  handler: (ctx: HookContext) => Promise<HookResult | undefined | void>;
}

/**
 * Holds every action/hook registered by vendored block code (via the plugin
 * host) for the lifetime of the process. Keys are `<block>.<name>`;
 * re-registering replaces (last write wins, like the service registry).
 */
export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition>();
  private readonly hooks = new Map<string, HookDefinition>();

  registerAction(definition: ActionDefinition): void {
    this.actions.set(key(definition.block, definition.name), definition);
  }

  registerHook(definition: HookDefinition): void {
    this.hooks.set(key(definition.block, definition.name), definition);
  }

  getAction(block: string, name: string): ActionDefinition | undefined {
    return this.actions.get(key(block, name));
  }

  getHook(block: string, name: string): HookDefinition | undefined {
    return this.hooks.get(key(block, name));
  }

  hasAction(block: string, name: string): boolean {
    return this.actions.has(key(block, name));
  }

  hasHook(block: string, name: string): boolean {
    return this.hooks.has(key(block, name));
  }

  /** All registered actions, optionally filtered to one block. */
  listActions(block?: string): ActionDefinition[] {
    const all = [...this.actions.values()];
    return block ? all.filter((a) => a.block === block) : all;
  }

  /** All registered hooks, optionally filtered to one block. */
  listHooks(block?: string): HookDefinition[] {
    const all = [...this.hooks.values()];
    return block ? all.filter((h) => h.block === block) : all;
  }
}

function key(block: string, name: string): string {
  return `${block}.${name}`;
}

/** Registry token — plugins reach the action registry via `ctx.actions` or this token. */
export const ACTION_REGISTRY = serviceToken<ActionRegistry>('actions');
