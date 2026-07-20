/**
 * GraphQL Resolver Factory — builds CRUD resolvers backed by the DataService.
 *
 * Every resolver here delegates to the same DataService used by the REST and
 * MCP surfaces, so all three stay behaviourally consistent. Resolvers are
 * generated per data object from its runtime definition.
 */

import { GraphQLError, type GraphQLFieldResolver } from 'graphql';
import type { PermissionEngine } from '../../auth/rbac/permission-engine.js';
import type { AuthPrincipal } from '../../auth/types.js';
import { ActionError, type ActionExecutor } from '../../blocks/action-executor.js';
import { type DataService, DataServiceError } from '../../data/data-service.js';
import type { FilterCondition, SortOption } from '../../data/types.js';

/**
 * Wraps a resolver so {@link DataServiceError}s surface as *typed* GraphQL
 * errors — `extensions.code` carries the platform error code (e.g.
 * `INVALID_CONFLICT_TARGET`, `unique_violation`) and the message is the
 * service's own, with the offending `field` attached when known. Without this,
 * yoga's error masking hides them behind an opaque INTERNAL_SERVER_ERROR —
 * a parity gap against REST, whose routes render the same errors as 4xx
 * envelopes. Anything that is not a DataServiceError still masks (a genuine
 * server fault should stay opaque).
 */
function withDataErrors<TArgs>(
  resolver: GraphQLFieldResolver<unknown, unknown, TArgs>,
): GraphQLFieldResolver<unknown, unknown, TArgs> {
  return async (source, args, context, info) => {
    try {
      return await resolver(source, args, context, info);
    } catch (err) {
      if (err instanceof DataServiceError) {
        throw new GraphQLError(err.message, {
          extensions: {
            code: err.code,
            ...(err.field !== undefined ? { field: err.field } : {}),
          },
        });
      }
      throw err;
    }
  };
}

/**
 * Anonymous-access guard for generated resolvers (issue #8). Present only when
 * RBAC enforcement is on: query resolvers then require the anonymous (null)
 * principal to hold a public read grant on the object, and mutation resolvers
 * reject anonymous callers outright. Authenticated principals pass — the
 * transport-level gate (`read` on `data`) already covered them.
 */
export interface AnonReadGuard {
  engine: PermissionEngine;
}

/** Extracts the request principal from the yoga context (null = anonymous). */
function contextAuth(context: unknown): AuthPrincipal | null {
  return (context as AuthCarryingContext | null)?.req?.auth ?? null;
}

/**
 * Throws unless an anonymous caller holds a public read grant on the object.
 * No-op without a guard (enforcement off) or for authenticated callers.
 */
export async function assertAnonymousCanRead(
  guard: AnonReadGuard | undefined,
  context: unknown,
  objectName: string,
): Promise<void> {
  if (!guard || contextAuth(context)) return;
  if (!(await guard.engine.can(null, 'read', objectName))) {
    throw new GraphQLError(`Missing permission: read on "${objectName}"`);
  }
}

/** Throws for anonymous callers when enforcement is on — writes need a credential. */
function assertNotAnonymous(guard: AnonReadGuard | undefined, context: unknown): void {
  if (guard && !contextAuth(context)) {
    throw new GraphQLError('Authentication required');
  }
}

/** Arguments accepted by a generated list query. */
interface ListArgs {
  filter?: FilterCondition[];
  search?: string;
  sort?: SortOption[];
  page?: number;
  pageSize?: number;
  limit?: number;
  offset?: number;
}

interface IdArg {
  id: string;
}

interface CreateArgs {
  input: Record<string, unknown>;
}

interface UpdateArgs {
  id: string;
  input?: Record<string, unknown> | null;
  /** Atomic per-field increments (issue #9): `{ wins: 1 }` → `wins = wins + 1`. */
  increment?: Record<string, number | null> | null;
}

interface UpsertArgs {
  input: Record<string, unknown>;
  onConflict: string[];
}

/**
 * List resolver — returns `{ data, pagination }` for a paginated, filtered query.
 */
export function makeListResolver(
  dataService: DataService,
  objectName: string,
  guard?: AnonReadGuard,
): GraphQLFieldResolver<unknown, unknown, ListArgs> {
  return withDataErrors(async (_source, args, context) => {
    await assertAnonymousCanRead(guard, context, objectName);
    return dataService.list(objectName, {
      filters: args.filter,
      search: args.search,
      sort: args.sort,
      pagination: {
        page: args.page ?? 1,
        pageSize: args.pageSize ?? 25,
        limit: args.limit,
        offset: args.offset,
      },
    });
  });
}

/** Arguments accepted by a generated aggregate query (issue #13). */
interface AggregateArgs {
  fn: string;
  field?: string | null;
  filter?: FilterCondition[];
  search?: string;
}

/**
 * Aggregate resolver — a single count/sum/avg/min/max over the rows matching
 * the same filter/search conditions as the list query. Field validation
 * (numeric-only for the value fns) lives in `DataService.aggregate`, shared
 * with REST and MCP.
 */
export function makeAggregateResolver(
  dataService: DataService,
  objectName: string,
  guard?: AnonReadGuard,
): GraphQLFieldResolver<unknown, unknown, AggregateArgs> {
  return withDataErrors(async (_source, args, context) => {
    await assertAnonymousCanRead(guard, context, objectName);
    return dataService.aggregate(objectName, args.fn, args.field ?? undefined, {
      filters: args.filter,
      search: args.search,
    });
  });
}

/**
 * Single-record resolver — returns the row (column-keyed) or null.
 */
export function makeGetResolver(
  dataService: DataService,
  objectName: string,
  guard?: AnonReadGuard,
): GraphQLFieldResolver<unknown, unknown, IdArg> {
  return withDataErrors(async (_source, args, context) => {
    await assertAnonymousCanRead(guard, context, objectName);
    const result = await dataService.getById(objectName, args.id);
    return result?.data ?? null;
  });
}

export function makeCreateResolver(
  dataService: DataService,
  objectName: string,
  guard?: AnonReadGuard,
): GraphQLFieldResolver<unknown, unknown, CreateArgs> {
  return withDataErrors(async (_source, args, context) => {
    assertNotAnonymous(guard, context);
    const result = await dataService.create(objectName, args.input);
    return result.data;
  });
}

/**
 * Update resolver. `increment` is the GraphQL face of the REST `$inc`
 * operator — a literal `$inc` key can't exist in a typed input, so atomic
 * adds ride a parallel `increment: { field: amount }` argument merged into
 * the shared DataService operator path (`SET field = field + amount`, one
 * statement, concurrency-safe).
 */
export function makeUpdateResolver(
  dataService: DataService,
  objectName: string,
  guard?: AnonReadGuard,
): GraphQLFieldResolver<unknown, unknown, UpdateArgs> {
  return withDataErrors(async (_source, args, context) => {
    assertNotAnonymous(guard, context);
    const data: Record<string, unknown> = { ...(args.input ?? {}) };
    for (const [field, amount] of Object.entries(args.increment ?? {})) {
      if (amount == null) continue;
      if (field in data) {
        throw new GraphQLError(
          `Field "${field}" cannot be both set (input) and incremented (increment)`,
        );
      }
      data[field] = { $inc: amount };
    }
    if (Object.keys(data).length === 0) {
      throw new GraphQLError('Provide "input" and/or "increment" with at least one field');
    }
    const result = await dataService.update(objectName, args.id, data);
    return result?.data ?? null;
  });
}

/**
 * Upsert resolver (issue #9) — `INSERT … ON CONFLICT (onConflict) DO UPDATE`
 * through the shared DataService path; resolves to `{ data, created }`.
 * Anonymous callers are rejected like every other write (issue #8) — an
 * anon-guarded create must not be reachable through upsert.
 */
export function makeUpsertResolver(
  dataService: DataService,
  objectName: string,
  guard?: AnonReadGuard,
): GraphQLFieldResolver<unknown, unknown, UpsertArgs> {
  return withDataErrors(async (_source, args, context) => {
    assertNotAnonymous(guard, context);
    return dataService.upsert(objectName, args.input, args.onConflict);
  });
}

export function makeDeleteResolver(
  dataService: DataService,
  objectName: string,
  guard?: AnonReadGuard,
): GraphQLFieldResolver<unknown, unknown, IdArg> {
  return withDataErrors(async (_source, args, context) => {
    assertNotAnonymous(guard, context);
    return dataService.delete(objectName, args.id);
  });
}

interface LinkArgs {
  id: string;
  ids: string[];
}

/** What the block-action mutations need beyond the executor itself. */
export interface ActionMutationDeps {
  actionExecutor: ActionExecutor;
  permissionEngine: PermissionEngine;
  /** When true, the manifest's RBAC requirement is enforced per invocation. */
  enforce: boolean;
}

/** The GraphQL context shape carrying the request principal (yoga server context). */
interface AuthCarryingContext {
  req?: { auth?: AuthPrincipal | null };
}

/**
 * Block-action mutation resolver (Phase 13) — the GraphQL face of the shared
 * ActionExecutor path (same resolution, RBAC, Zod validation, telemetry, and
 * timeout as REST and MCP). ActionErrors become GraphQLErrors so yoga's
 * error masking doesn't swallow the actionable message.
 */
export function makeActionResolver(
  deps: ActionMutationDeps,
  block: string,
  action: string,
): GraphQLFieldResolver<unknown, unknown, { input?: Record<string, unknown> | null }> {
  return async (_source, args, context) => {
    const auth = (context as AuthCarryingContext | null)?.req?.auth ?? null;
    try {
      const { definition, rbac } = await deps.actionExecutor.resolveAction(block, action);
      if (deps.enforce) {
        if (!auth) throw new GraphQLError('Authentication required');
        const ok = await deps.permissionEngine.can(auth, rbac.action, rbac.resource);
        if (!ok) {
          throw new GraphQLError(`Missing permission: ${rbac.action} on "${rbac.resource}"`);
        }
      }
      return await deps.actionExecutor.executeAction(definition, args.input ?? {}, auth);
    } catch (err) {
      if (err instanceof ActionError) {
        throw new GraphQLError(err.message, {
          extensions: { code: err.code, issues: err.issues },
        });
      }
      throw err;
    }
  };
}

/**
 * Link/unlink resolver (Phase 13) — writes many_to_many junction rows through
 * the shared DataService link operations; returns the number of links that
 * actually changed.
 */
export function makeLinkResolver(
  dataService: DataService,
  objectName: string,
  relKey: string,
  mode: 'link' | 'unlink',
  guard?: AnonReadGuard,
): GraphQLFieldResolver<unknown, unknown, LinkArgs> {
  return withDataErrors(async (_source, args, context) => {
    assertNotAnonymous(guard, context);
    return mode === 'link'
      ? (await dataService.addLinks(objectName, args.id, relKey, args.ids)).added
      : (await dataService.removeLinks(objectName, args.id, relKey, args.ids)).removed;
  });
}
