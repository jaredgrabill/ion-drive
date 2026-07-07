/**
 * @module @ion-drive/client
 *
 * Ion Drive client SDK — a zero-dependency, typed query builder and fetch
 * client for the Ion Drive REST API. Import it into any project (Node or
 * browser) that talks to an Ion Drive server:
 *
 *   import { IonDriveClient, query } from '@ion-drive/client';
 *
 *   const ion = new IonDriveClient({ baseUrl, apiKey });
 *   const { data } = await ion.from('contacts').select().search('acme').page(1);
 *
 * Or build query strings standalone (e.g. for a `fetch` you already have):
 *
 *   const qs = query().neq('status', 'archived').gt('created_at', '2020-10-10').toQueryString();
 */

export { IonDriveClient, Resource, ResourceQuery, IonDriveError } from './client.js';
export { EventsApi } from './events.js';
export type {
  EventStreamHandle,
  EventStreamOptions,
  EventsTransport,
  IonEventMessage,
} from './events.js';
export { QueryBuilder, QueryBuilderError, query } from './query-builder.js';
export type {
  IonDriveClientOptions,
  FilterOperator,
  OperatorAlias,
  SortDirection,
  PaginationMeta,
  QueryResult,
  SingleResult,
  BulkResult,
  Record_,
} from './types.js';
