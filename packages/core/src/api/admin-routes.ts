/**
 * Admin / management API — RBAC, users, secrets, config, and API keys.
 *
 * These endpoints back the admin console's user-management, security, and
 * settings screens. Each is guarded by an RBAC permission when enforcement is
 * enabled (config.requireAuth); when disabled, the guards are no-ops so local
 * development and first-run setup are frictionless.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type { ApiKeyManager } from '../auth/api-key-manager.js';
import { requirePermission } from '../auth/rbac/middleware.js';
import type { PermissionEngine } from '../auth/rbac/permission-engine.js';
import { type Action, PUBLIC_ROLE_NAME } from '../auth/rbac/policy-types.js';
import { type RoleManager, RoleValidationError } from '../auth/rbac/role-manager.js';
import type { ConfigStore } from '../config/config-store.js';
import type { SecretsManager } from '../config/secrets-manager.js';
import type { SystemDatabase } from '../db/types.js';

export interface AdminRoutesServices {
  roleManager: RoleManager;
  permissionEngine: PermissionEngine;
  secretsManager: SecretsManager;
  configStore: ConfigStore;
  apiKeyManager: ApiKeyManager;
  systemDb: Kysely<SystemDatabase>;
  /** When true, endpoints are protected by RBAC permissions. */
  enforce: boolean;
}

/**
 * Row-policy grammar (issue #7): `all`/`own`/`none` or a single-field match
 * bound to `actor.id`. Shape-only here — RoleManager re-validates deeply
 * (exactly one of equals/contains) on every mutation path.
 */
const rowPolicySchema = z.union([
  z.enum(['all', 'own', 'none']),
  z
    .object({
      field: z.string().min(1),
      equals: z.literal('actor.id').optional(),
      contains: z.literal('actor.id').optional(),
    })
    .strict(),
]);

const permissionGrantSchema = z.object({
  resource: z.string().min(1),
  actions: z.array(z.enum(['create', 'read', 'update', 'delete', 'manage'])).min(1),
  rowPolicy: rowPolicySchema.optional(),
});

const roleInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullish(),
  permissions: z.array(permissionGrantSchema).default([]),
});

/** Maps a {@link RoleValidationError} to a 400; re-throws anything else. */
function sendRoleValidationError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof RoleValidationError) {
    return reply.code(400).send({ error: 'Validation Error', message: err.message });
  }
  throw err;
}

export function registerAdminRoutes(services: AdminRoutesServices): FastifyPluginCallback {
  const { roleManager, permissionEngine, secretsManager, configStore, apiKeyManager, systemDb } =
    services;

  /** Returns an RBAC guard, or a no-op when enforcement is disabled. */
  const guard = (action: Action, resource: string): preHandlerHookHandler => {
    if (!services.enforce) return (_req, _reply, done) => done();
    return requirePermission(permissionEngine, action, resource);
  };

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // --- Current principal ---
    fastify.get('/me', async (request) => {
      if (!request.auth) return { authenticated: false };
      const roles = await permissionEngine.getEffectiveRoleNames(request.auth);
      return {
        authenticated: true,
        via: request.auth.via,
        user: request.auth.user,
        userId: request.auth.userId,
        roles,
      };
    });

    // --- Roles ---
    fastify.get('/roles', { preHandler: guard('read', 'roles') }, async () => ({
      data: await roleManager.list(),
    }));

    fastify.post('/roles', { preHandler: guard('manage', 'roles') }, async (request, reply) => {
      const parsed = roleInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
      }
      try {
        const role = await roleManager.create({
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          permissions: parsed.data.permissions,
        });
        return reply.code(201).send({ data: role });
      } catch (err) {
        return sendRoleValidationError(reply, err);
      }
    });

    fastify.patch<{ Params: { id: string } }>(
      '/roles/:id',
      { preHandler: guard('manage', 'roles') },
      async (request, reply) => {
        const parsed = roleInputSchema.partial().safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
        }
        try {
          const role = await roleManager.update(request.params.id, {
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            permissions: parsed.data.permissions,
          });
          if (!role) return reply.code(404).send({ error: 'Not Found', message: 'Role not found' });
          return { data: role };
        } catch (err) {
          return sendRoleValidationError(reply, err);
        }
      },
    );

    fastify.delete<{ Params: { id: string } }>(
      '/roles/:id',
      { preHandler: guard('manage', 'roles') },
      async (request, reply) => {
        const deleted = await roleManager.delete(request.params.id);
        if (!deleted) {
          return reply
            .code(409)
            .send({ error: 'Conflict', message: 'Role not found or is system-managed' });
        }
        return reply.code(204).send();
      },
    );

    fastify.get<{ Params: { id: string } }>(
      '/roles/:id/users',
      { preHandler: guard('read', 'roles') },
      async (request) => ({ data: await roleManager.getUsersForRole(request.params.id) }),
    );

    fastify.post<{ Params: { id: string }; Body: { userId?: string } }>(
      '/roles/:id/assignments',
      { preHandler: guard('manage', 'users') },
      async (request, reply) => {
        const userId = request.body?.userId;
        if (!userId) {
          return reply.code(400).send({ error: 'Validation Error', message: 'userId is required' });
        }
        try {
          await roleManager.assign(userId, request.params.id);
        } catch (err) {
          return sendRoleValidationError(reply, err);
        }
        return reply.code(201).send({ success: true });
      },
    );

    fastify.delete<{ Params: { id: string; userId: string } }>(
      '/roles/:id/assignments/:userId',
      { preHandler: guard('manage', 'users') },
      async (request, reply) => {
        const removed = await roleManager.unassign(request.params.userId, request.params.id);
        if (!removed)
          return reply.code(404).send({ error: 'Not Found', message: 'Assignment not found' });
        return reply.code(204).send();
      },
    );

    // --- Users (managed by the auth provider; listed read-only here) ---
    fastify.get('/users', { preHandler: guard('read', 'users') }, async () => {
      const result = await sql<{
        id: string;
        email: string;
        name: string | null;
        createdAt: Date;
      }>`SELECT id, email, name, "createdAt" FROM "user" ORDER BY "createdAt" DESC LIMIT 500`.execute(
        systemDb,
      );
      const users = result.rows;
      // Attach role names per user.
      const withRoles = await Promise.all(
        users.map(async (u) => ({
          ...u,
          roles: (await roleManager.getRolesForUser(u.id)).map((r) => r.name),
        })),
      );
      return { data: withRoles };
    });

    fastify.get<{ Params: { id: string } }>(
      '/users/:id/roles',
      { preHandler: guard('read', 'users') },
      async (request) => ({ data: await roleManager.getRolesForUser(request.params.id) }),
    );

    // --- Secrets (values never returned in list) ---
    fastify.get('/secrets', { preHandler: guard('read', 'secrets') }, async () => ({
      data: await secretsManager.list(),
    }));

    fastify.put<{ Params: { key: string }; Body: { value?: string; description?: string } }>(
      '/secrets/:key',
      { preHandler: guard('manage', 'secrets') },
      async (request, reply) => {
        const value = request.body?.value;
        if (typeof value !== 'string') {
          return reply
            .code(400)
            .send({ error: 'Validation Error', message: 'value (string) is required' });
        }
        await secretsManager.set(request.params.key, value, request.body?.description);
        return reply.code(204).send();
      },
    );

    fastify.delete<{ Params: { key: string } }>(
      '/secrets/:key',
      { preHandler: guard('manage', 'secrets') },
      async (request, reply) => {
        const deleted = await secretsManager.delete(request.params.key);
        if (!deleted)
          return reply.code(404).send({ error: 'Not Found', message: 'Secret not found' });
        return reply.code(204).send();
      },
    );

    // --- Config ---
    fastify.get('/config', { preHandler: guard('read', 'config') }, async () => ({
      data: await configStore.list(),
    }));

    fastify.put<{ Params: { key: string }; Body: { value?: unknown; description?: string } }>(
      '/config/:key',
      { preHandler: guard('manage', 'config') },
      async (request, reply) => {
        if (request.body?.value === undefined) {
          return reply.code(400).send({ error: 'Validation Error', message: 'value is required' });
        }
        await configStore.set(request.params.key, request.body.value, request.body?.description);
        return reply.code(204).send();
      },
    );

    fastify.delete<{ Params: { key: string } }>(
      '/config/:key',
      { preHandler: guard('manage', 'config') },
      async (request, reply) => {
        const deleted = await configStore.delete(request.params.key);
        if (!deleted)
          return reply.code(404).send({ error: 'Not Found', message: 'Config key not found' });
        return reply.code(204).send();
      },
    );

    // --- API keys ---
    fastify.get('/api-keys', { preHandler: guard('read', 'api_keys') }, async () => ({
      data: await apiKeyManager.list(),
    }));

    fastify.post<{
      Body: { name?: string; roleId?: string; userId?: string; expiresAt?: string };
    }>('/api-keys', { preHandler: guard('manage', 'api_keys') }, async (request, reply) => {
      const name = request.body?.name;
      if (!name) {
        return reply.code(400).send({ error: 'Validation Error', message: 'name is required' });
      }
      // The public role represents anonymous requests — binding it to a
      // credential is a category error (issue #8 rail, like user assignment).
      if (request.body?.roleId) {
        const role = await roleManager.getById(request.body.roleId);
        if (role?.name === PUBLIC_ROLE_NAME) {
          return reply.code(400).send({
            error: 'Validation Error',
            message: 'The public role cannot be bound to an API key',
          });
        }
      }
      const created = await apiKeyManager.create({
        name,
        roleId: request.body?.roleId ?? null,
        userId: request.body?.userId ?? null,
        expiresAt: request.body?.expiresAt ? new Date(request.body.expiresAt) : null,
      });
      // The plaintext key is returned exactly once.
      return reply.code(201).send({ data: created });
    });

    fastify.delete<{ Params: { id: string } }>(
      '/api-keys/:id',
      { preHandler: guard('manage', 'api_keys') },
      async (request, reply) => {
        const revoked = await apiKeyManager.revoke(request.params.id);
        if (!revoked)
          return reply.code(404).send({ error: 'Not Found', message: 'API key not found' });
        return reply.code(204).send();
      },
    );

    done();
  };
}
