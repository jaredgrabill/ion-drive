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
import type { DataService } from '../../data/data-service.js';
import type { FilterCondition, SortOption } from '../../data/types.js';

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
  input: Record<string, unknown>;
}

/**
 * List resolver — returns `{ data, pagination }` for a paginated, filtered query.
 */
export function makeListResolver(
  dataService: DataService,
  objectName: string,
): GraphQLFieldResolver<unknown, unknown, ListArgs> {
  return async (_source, args) =>
    dataService.list(objectName, {
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
}

/**
 * Single-record resolver — returns the row (column-keyed) or null.
 */
export function makeGetResolver(
  dataService: DataService,
  objectName: string,
): GraphQLFieldResolver<unknown, unknown, IdArg> {
  return async (_source, args) => {
    const result = await dataService.getById(objectName, args.id);
    return result?.data ?? null;
  };
}

export function makeCreateResolver(
  dataService: DataService,
  objectName: string,
): GraphQLFieldResolver<unknown, unknown, CreateArgs> {
  return async (_source, args) => {
    const result = await dataService.create(objectName, args.input);
    return result.data;
  };
}

export function makeUpdateResolver(
  dataService: DataService,
  objectName: string,
): GraphQLFieldResolver<unknown, unknown, UpdateArgs> {
  return async (_source, args) => {
    const result = await dataService.update(objectName, args.id, args.input);
    return result?.data ?? null;
  };
}

export function makeDeleteResolver(
  dataService: DataService,
  objectName: string,
): GraphQLFieldResolver<unknown, unknown, IdArg> {
  return async (_source, args) => dataService.delete(objectName, args.id);
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
): GraphQLFieldResolver<unknown, unknown, LinkArgs> {
  return async (_source, args) =>
    mode === 'link'
      ? (await dataService.addLinks(objectName, args.id, relKey, args.ids)).added
      : (await dataService.removeLinks(objectName, args.id, relKey, args.ids)).removed;
}
