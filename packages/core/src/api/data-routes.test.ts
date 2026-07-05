import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataService } from '../data/data-service.js';
import { SchemaRegistry } from '../schema/schema-registry.js';
import type { DataObjectDefinition } from '../schema/types.js';
import { registerDataRoutes } from './data-routes.js';

const CONTACTS: DataObjectDefinition = {
  name: 'contacts',
  displayName: 'Contacts',
  tableName: 'contacts',
  fields: [
    {
      name: 'id',
      displayName: 'ID',
      columnName: 'id',
      columnType: 'uuid',
      isPrimary: true,
      isSystem: true,
    },
    {
      name: 'full_name',
      displayName: 'Full Name',
      columnName: 'full_name',
      columnType: 'text',
      isRequired: true,
    },
  ],
};

const SYSTEM_OBJECT: DataObjectDefinition = {
  name: '_internal',
  displayName: 'Internal',
  tableName: '_internal',
  isSystem: true,
  fields: [],
};

function buildApp(dataService: DataService): { app: FastifyInstance; registry: SchemaRegistry } {
  const registry = new SchemaRegistry();
  registry.registerObject(CONTACTS);
  registry.registerObject(SYSTEM_OBJECT);

  const app = Fastify();
  app.register(registerDataRoutes({ dataService, registry }), { prefix: '/api/v1/data' });
  return { app, registry };
}

describe('data-routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('lists available (non-system) objects on the discovery endpoint', async () => {
    ({ app } = buildApp({} as DataService));
    const res = await app.inject({ method: 'GET', url: '/api/v1/data' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.data[0].name).toBe('contacts');
  });

  it('returns 404 for an unknown object', async () => {
    ({ app } = buildApp({} as DataService));
    const res = await app.inject({ method: 'GET', url: '/api/v1/data/unknown' });
    expect(res.statusCode).toBe(404);
  });

  it('hides system objects from the data API', async () => {
    ({ app } = buildApp({} as DataService));
    const res = await app.inject({ method: 'GET', url: '/api/v1/data/_internal' });
    expect(res.statusCode).toBe(404);
  });

  it('delegates list to the DataService', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ id: '1' }], pagination: {} });
    ({ app } = buildApp({ list } as unknown as DataService));

    const res = await app.inject({ method: 'GET', url: '/api/v1/data/contacts?full_name[like]=a' });
    expect(res.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(
      'contacts',
      expect.objectContaining({ filters: expect.any(Array) }),
    );
  });

  it('passes the free-text search term through to the DataService', async () => {
    const list = vi.fn().mockResolvedValue({ data: [], pagination: {} });
    ({ app } = buildApp({ list } as unknown as DataService));

    const res = await app.inject({ method: 'GET', url: '/api/v1/data/contacts?search=acme' });
    expect(res.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith('contacts', expect.objectContaining({ search: 'acme' }));
  });

  it('rejects a create with a non-object body', async () => {
    ({ app } = buildApp({} as DataService));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/data/contacts',
      payload: JSON.stringify(['not', 'an', 'object']),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('routes /:object/bulk to bulk operations, not /:object/:id', async () => {
    const bulkCreate = vi.fn().mockResolvedValue({ count: 2, ids: ['a', 'b'] });
    ({ app } = buildApp({ bulkCreate } as unknown as DataService));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/data/contacts/bulk',
      payload: { data: [{ full_name: 'A' }, { full_name: 'B' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(bulkCreate).toHaveBeenCalledOnce();
    expect(res.json().count).toBe(2);
  });

  it('returns 404 when a record is not found', async () => {
    const getById = vi.fn().mockResolvedValue(null);
    ({ app } = buildApp({ getById } as unknown as DataService));

    const res = await app.inject({ method: 'GET', url: '/api/v1/data/contacts/missing-id' });
    expect(res.statusCode).toBe(404);
  });
});
