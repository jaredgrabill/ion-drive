/**
 * GraphQL Resolver Factory — builds CRUD resolvers backed by the DataService.
 *
 * Every resolver here delegates to the same DataService used by the REST and
 * MCP surfaces, so all three stay behaviourally consistent. Resolvers are
 * generated per data object from its runtime definition.
 */

import type { GraphQLFieldResolver } from 'graphql';
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
