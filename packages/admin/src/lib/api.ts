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
  ColumnType,
  ConfigEntry,
  CreatedApiKey,
  CurrentUser,
  DataObjectDefinition,
  FieldDefinition,
  ObjectSummary,
  PermissionGrant,
  RecordListResult,
  Role,
  SecretMetadata,
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
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
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
  removeField: (objectName: string, fieldName: string) =>
    request(`/schema/objects/${objectName}/fields/${fieldName}`, { method: 'DELETE' }),

  // --- Data records ---
  listRecords: (objectName: string, query = '') =>
    request<RecordListResult>(`/data/${objectName}${query}`),
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

  // --- API keys ---
  listApiKeys: () => request<{ data: ApiKeyMetadata[] }>('/api-keys').then((r) => r.data),
  createApiKey: (input: { name: string; roleId?: string; userId?: string; expiresAt?: string }) =>
    request<{ data: CreatedApiKey }>('/api-keys', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),
  revokeApiKey: (id: string) => request(`/api-keys/${id}`, { method: 'DELETE' }),
};
