/**
 * Typed API client for the Ion Drive backend.
 *
 * All requests go through the Vite dev proxy (`/api` → the core server) with
 * credentials so the Better Auth session cookie is sent. Non-2xx responses throw
 * an {@link ApiError} carrying the server's message.
 */

import type {
  AdminUser,
  ApiKeyMetadata,
  ChangePreview,
  ColumnType,
  ConfigEntry,
  CreatedApiKey,
  CreatedWebhook,
  CurrentUser,
  DataObjectDefinition,
  DeliveryQueryParams,
  DeliveryRecord,
  DoctorReport,
  ErrorEntry,
  EventRecord,
  FieldDefinition,
  FieldModification,
  InstalledBlock,
  LogEntry,
  LogQueryParams,
  ObjectSummary,
  PermissionGrant,
  RecordListResult,
  Role,
  SecretMetadata,
  StatsSnapshot,
  TaskDef,
  TaskHandlerInfo,
  TaskInput,
  TaskRun,
  TaskWithRuns,
  TrafficPeriod,
  TrafficSummary,
  VersionInfo,
  Webhook,
  WebhookInput,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    // Only declare a JSON body when there is one — Fastify rejects an empty
    // body sent with content-type: application/json (e.g. POST /tasks/:id/run).
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.message ?? body?.error ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

/** Serializes defined params into a query string (empty string when none). */
function toSearchParams(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // --- Current user ---
  me: () => request<CurrentUser>('/me'),

  // --- Schema ---
  listObjects: () => request<{ data: ObjectSummary[] }>('/schema/objects').then((r) => r.data),
  getObject: (name: string) =>
    request<{ data: DataObjectDefinition }>(`/schema/objects/${name}`).then((r) => r.data),
  columnTypes: () => request<{ data: ColumnType[] }>('/schema/column-types').then((r) => r.data),
  createObject: (input: {
    name: string;
    displayName: string;
    description?: string;
    fields: Partial<FieldDefinition>[];
  }) => request('/schema/objects', { method: 'POST', body: JSON.stringify(input) }),
  deleteObject: (name: string) => request(`/schema/objects/${name}`, { method: 'DELETE' }),
  addField: (objectName: string, field: Partial<FieldDefinition>) =>
    request(`/schema/objects/${objectName}/fields`, {
      method: 'POST',
      body: JSON.stringify(field),
    }),
  removeField: (objectName: string, fieldName: string, force = false) =>
    request(`/schema/objects/${objectName}/fields/${fieldName}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),
  /** Preview a field modification without applying (Phase 10). */
  previewFieldChange: (objectName: string, fieldName: string, updates: FieldModification) =>
    request<{ data: ChangePreview }>(
      `/schema/objects/${objectName}/fields/${fieldName}?dryRun=true`,
      { method: 'PATCH', body: JSON.stringify(updates) },
    ).then((r) => r.data),
  /** Apply a field modification (Phase 10). */
  modifyField: (
    objectName: string,
    fieldName: string,
    updates: FieldModification,
    opts: { force?: boolean } = {},
  ) =>
    request<{ success: boolean; preview: ChangePreview; field?: FieldDefinition }>(
      `/schema/objects/${objectName}/fields/${fieldName}${opts.force ? '?force=true' : ''}`,
      { method: 'PATCH', body: JSON.stringify(updates) },
    ),
  /** Schema drift doctor (Phase 10). */
  schemaDoctor: () => request<{ data: DoctorReport }>('/schema/doctor').then((r) => r.data),
  doctorAdopt: (table: string, column?: string) =>
    request('/schema/doctor/adopt', { method: 'POST', body: JSON.stringify({ table, column }) }),
  doctorIgnore: (key: string) =>
    request('/schema/doctor/ignore', { method: 'POST', body: JSON.stringify({ key }) }),
  doctorUnignore: (key: string) =>
    request('/schema/doctor/unignore', { method: 'POST', body: JSON.stringify({ key }) }),
  addRelationship: (input: {
    name: string;
    displayName: string;
    type: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
    sourceObjectName: string;
    targetObjectName: string;
    cascadeDelete?: boolean;
  }) => request('/schema/relationships', { method: 'POST', body: JSON.stringify(input) }),
  /** Preview a relationship removal without applying (Phase 13). */
  previewRemoveRelationship: (sourceObject: string, relName: string, force = false) =>
    request<{ data: ChangePreview }>(
      `/schema/objects/${sourceObject}/relationships/${relName}?dryRun=true${force ? '&force=true' : ''}`,
      { method: 'DELETE' },
    ).then((r) => r.data),
  /** Remove a relationship — drops the FK column or junction table (Phase 13). */
  removeRelationship: (sourceObject: string, relName: string, force = false) =>
    request<{ success: boolean; preview: ChangePreview }>(
      `/schema/objects/${sourceObject}/relationships/${relName}${force ? '?force=true' : ''}`,
      { method: 'DELETE' },
    ),

  // --- Data records ---
  listRecords: (objectName: string, query = '') =>
    request<RecordListResult>(`/data/${objectName}${query}`),
  getRecord: (objectName: string, id: string, expand?: string) =>
    request<{ data: Record<string, unknown> }>(
      `/data/${objectName}/${id}${expand ? `?expand=${encodeURIComponent(expand)}` : ''}`,
    ).then((r) => r.data),
  createRecord: (objectName: string, data: Record<string, unknown>) =>
    request<{ data: Record<string, unknown> }>(`/data/${objectName}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateRecord: (objectName: string, id: string, data: Record<string, unknown>) =>
    request<{ data: Record<string, unknown> }>(`/data/${objectName}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteRecord: (objectName: string, id: string) =>
    request(`/data/${objectName}/${id}`, { method: 'DELETE' }),
  bulkDeleteRecords: (objectName: string, ids: string[]) =>
    request<{ count: number; ids: string[] }>(`/data/${objectName}/bulk`, {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
  /** Add many_to_many links (Phase 13). Idempotent; returns the number added. */
  addLinks: (objectName: string, id: string, relName: string, ids: string[]) =>
    request<{ data: { added: number } }>(`/data/${objectName}/${id}/links/${relName}`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }).then((r) => r.data),
  /** Remove many_to_many links (Phase 13). Returns the number removed. */
  removeLinks: (objectName: string, id: string, relName: string, ids: string[]) =>
    request<{ data: { removed: number } }>(`/data/${objectName}/${id}/links/${relName}`, {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }).then((r) => r.data),

  // --- Roles ---
  listRoles: () => request<{ data: Role[] }>('/roles').then((r) => r.data),
  createRole: (input: { name: string; description?: string; permissions: PermissionGrant[] }) =>
    request('/roles', { method: 'POST', body: JSON.stringify(input) }),
  updateRole: (
    id: string,
    input: Partial<{ name: string; description: string; permissions: PermissionGrant[] }>,
  ) => request(`/roles/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteRole: (id: string) => request(`/roles/${id}`, { method: 'DELETE' }),
  assignRole: (roleId: string, userId: string) =>
    request(`/roles/${roleId}/assignments`, { method: 'POST', body: JSON.stringify({ userId }) }),
  unassignRole: (roleId: string, userId: string) =>
    request(`/roles/${roleId}/assignments/${userId}`, { method: 'DELETE' }),

  // --- Users ---
  listUsers: () => request<{ data: AdminUser[] }>('/users').then((r) => r.data),

  // --- Secrets ---
  listSecrets: () => request<{ data: SecretMetadata[] }>('/secrets').then((r) => r.data),
  setSecret: (key: string, value: string, description?: string) =>
    request(`/secrets/${key}`, { method: 'PUT', body: JSON.stringify({ value, description }) }),
  deleteSecret: (key: string) => request(`/secrets/${key}`, { method: 'DELETE' }),

  // --- Config ---
  listConfig: () => request<{ data: ConfigEntry[] }>('/config').then((r) => r.data),
  setConfig: (key: string, value: unknown, description?: string) =>
    request(`/config/${key}`, { method: 'PUT', body: JSON.stringify({ value, description }) }),
  deleteConfig: (key: string) => request(`/config/${key}`, { method: 'DELETE' }),

  // --- Stats & version (Phase 8) ---
  stats: () => request<{ data: StatsSnapshot }>('/stats').then((r) => r.data),
  traffic: (period: TrafficPeriod = '24h') =>
    request<{ data: TrafficSummary }>(`/stats/traffic?period=${period}`).then((r) => r.data),
  recentErrors: (limit = 10) =>
    request<{ data: ErrorEntry[] }>(`/stats/errors?limit=${limit}`).then((r) => r.data),
  version: () => request<{ data: VersionInfo }>('/version').then((r) => r.data),

  // --- Logs (Phase 8; the SSE stream is consumed via EventSource in the page) ---
  queryLogs: (params: LogQueryParams = {}) =>
    request<{ data: LogEntry[]; total: number }>(
      `/logs${toSearchParams(params as Record<string, string | number | undefined>)}`,
    ),
  logSources: () => request<{ data: string[] }>('/logs/sources').then((r) => r.data),

  // --- Tasks ---
  listTasks: () => request<{ data: TaskDef[] }>('/tasks').then((r) => r.data),
  listTaskHandlers: () =>
    request<{ data: TaskHandlerInfo[] }>('/tasks/handlers').then((r) => r.data),
  getTask: (id: string) => request<{ data: TaskWithRuns }>(`/tasks/${id}`).then((r) => r.data),
  createTask: (input: TaskInput) =>
    request<{ data: TaskDef }>('/tasks', { method: 'POST', body: JSON.stringify(input) }),
  updateTask: (id: string, patch: Partial<TaskInput>) =>
    request<{ data: TaskDef }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: 'DELETE' }),
  runTask: (id: string) => request<{ data: TaskRun }>(`/tasks/${id}/run`, { method: 'POST' }),
  taskRuns: (id: string, limit = 50) =>
    request<{ data: TaskRun[] }>(`/tasks/${id}/runs?limit=${limit}`).then((r) => r.data),

  // --- Building blocks ---
  listBlocks: () => request<{ data: InstalledBlock[] }>('/blocks').then((r) => r.data),
  getBlock: (name: string) =>
    request<{ data: InstalledBlock }>(`/blocks/${name}`).then((r) => r.data),
  uninstallBlock: (name: string, dropData = false) =>
    request(`/blocks/${name}?dropData=${dropData}`, { method: 'DELETE' }),

  // --- Events & webhooks (Phase 12; the SSE stream is consumed via EventSource in the page) ---
  listEvents: (params: { topic?: string; limit?: number; offset?: number } = {}) =>
    request<{ data: EventRecord[]; totalCount: number }>(
      `/events${toSearchParams(params as Record<string, string | number | undefined>)}`,
    ),
  listDeliveries: (params: DeliveryQueryParams = {}) =>
    request<{ data: DeliveryRecord[]; totalCount: number }>(
      `/events/deliveries${toSearchParams({
        ...params,
        dead: params.dead ? 'true' : undefined,
      } as Record<string, string | number | undefined>)}`,
    ),
  retryDelivery: (eventId: string, consumer: string) =>
    request('/events/deliveries/retry', {
      method: 'POST',
      body: JSON.stringify({ eventId, consumer }),
    }),
  listWebhooks: () => request<{ data: Webhook[] }>('/webhooks').then((r) => r.data),
  createWebhook: (input: WebhookInput) =>
    request<{ data: CreatedWebhook }>('/webhooks', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),
  updateWebhook: (id: string, patch: Partial<WebhookInput>) =>
    request<{ data: Webhook }>(`/webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.data),
  deleteWebhook: (id: string) => request(`/webhooks/${id}`, { method: 'DELETE' }),
  testWebhook: (id: string) => request(`/webhooks/${id}/test`, { method: 'POST' }),

  // --- API keys ---
  listApiKeys: () => request<{ data: ApiKeyMetadata[] }>('/api-keys').then((r) => r.data),
  createApiKey: (input: { name: string; roleId?: string; userId?: string; expiresAt?: string }) =>
    request<{ data: CreatedApiKey }>('/api-keys', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),
  revokeApiKey: (id: string) => request(`/api-keys/${id}`, { method: 'DELETE' }),
};
