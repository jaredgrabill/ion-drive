/**
 * Standard span/metric attribute keys for Ion Drive telemetry.
 *
 * We reuse OpenTelemetry semantic conventions where they exist (HTTP, service)
 * and add a small `ion.*` namespace for platform-specific dimensions (the data
 * object being operated on, the API surface a request came through, task ids,
 * schema-change kinds). Keeping these as constants avoids typos and keeps the
 * trace/metric/log dimensions consistent across the REST, GraphQL, and MCP
 * surfaces — a stated product goal.
 */

export {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_ROUTE,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions';

/** Ion-Drive-specific span/metric attribute keys. */
export const ION_ATTR = {
  /** The API surface a request arrived through: `rest` | `graphql` | `mcp` | `admin` | `auth`. */
  SURFACE: 'ion.surface',
  /** The data object (table) a request or operation targets, when applicable. */
  OBJECT: 'ion.object',
  /** The kind of schema change: `create_object` | `alter_object` | `drop_object` | … */
  SCHEMA_CHANGE: 'ion.schema.change',
  /** A scheduled/background task's id. */
  TASK_ID: 'ion.task.id',
  /** A scheduled/background task's name. */
  TASK_NAME: 'ion.task.name',
  /** How a task run was triggered: `schedule` | `manual`. */
  TASK_TRIGGER: 'ion.task.trigger',
  /** A task handler's type: `log` | `http_request` | `noop` | … */
  TASK_TYPE: 'ion.task.type',
  /** A bus event's topic, e.g. `data.contacts.create`. */
  EVENT_TOPIC: 'ion.event.topic',
  /** The consumer group an event delivery was claimed for. */
  EVENT_CONSUMER: 'ion.event.consumer',
  /** The bus handler a subscription routes to: `log_event` | `persist_event` | … */
  EVENT_HANDLER: 'ion.event.handler',
  /** The building block an action/hook invocation belongs to. */
  BLOCK: 'ion.block',
  /** A block action's name, e.g. `create_payment_link`. */
  ACTION: 'ion.action',
  /** A block webhook hook's name, e.g. `stripe`. */
  HOOK: 'ion.hook',
  /** Terminal status of an operation: `success` | `failed`. */
  OUTCOME: 'ion.outcome',
} as const;

/** Classifies a request path into one of the Ion Drive API surfaces. */
export function surfaceForPath(path: string): string {
  if (path.startsWith('/api/v1/graphql')) return 'graphql';
  if (path.startsWith('/api/v1/mcp')) return 'mcp';
  if (path.startsWith('/api/v1/data')) return 'rest';
  if (path.startsWith('/api/v1/schema')) return 'schema';
  if (path.startsWith('/api/auth')) return 'auth';
  if (path.startsWith('/api/v1')) return 'admin';
  return 'other';
}
