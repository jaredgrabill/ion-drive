/**
 * Global RBAC enforcement for the generated API surfaces.
 *
 * The data/schema/GraphQL/MCP surfaces share handlers across many objects, so
 * rather than guard each route we install one `onRequest` hook that maps the
 * request path + method to an RBAC (action, resource) pair and checks it.
 *
 * Enforcement is intentionally coarse for GraphQL and MCP (a single gate at the
 * transport) — field/operation-level RBAC for those is a future refinement.
 * Admin routes self-guard, so they are skipped here.
 *
 * Install this only when auth is required (config.requireAuth); when it is not,
 * the surfaces remain open for local development.
 */

import type { FastifyInstance } from 'fastify';
import { methodToAction } from './middleware.js';
import type { PermissionEngine } from './permission-engine.js';
import type { Action } from './policy-types.js';

function isPublic(pathname: string, method: string): boolean {
  if (pathname === '/health' || pathname === '/api/v1' || pathname === '/api/v1/openapi.json') {
    return true;
  }
  if (pathname.startsWith('/api/auth')) return true;
  // The GraphiQL playground loads over GET; actual operations are POST.
  if (pathname.startsWith('/api/v1/graphql') && method === 'GET') return true;
  return false;
}

/** Resolves the (action, resource) an incoming request requires, or null if unguarded here. */
function resolveRequirement(
  pathname: string,
  method: string,
): { action: Action; resource: string } | null {
  if (pathname.startsWith('/api/v1/data')) {
    const segments = pathname.split('/').filter(Boolean); // api, v1, data, <object>, <id>
    return { action: methodToAction(method), resource: segments[3] ?? 'data' };
  }
  if (pathname.startsWith('/api/v1/schema')) {
    return { action: method === 'GET' ? 'read' : 'manage', resource: 'schema' };
  }
  if (pathname.startsWith('/api/v1/graphql')) {
    return { action: 'read', resource: 'data' };
  }
  if (pathname.startsWith('/api/v1/mcp')) {
    return { action: 'manage', resource: 'data' };
  }
  return null;
}

export function installRbacEnforcement(fastify: FastifyInstance, engine: PermissionEngine): void {
  fastify.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? request.url;
    const method = request.method;
    if (isPublic(pathname, method)) return;

    const requirement = resolveRequirement(pathname, method);
    if (!requirement) return; // admin routes self-guard; everything else is public

    if (!request.auth) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }
    const allowed = await engine.can(request.auth, requirement.action, requirement.resource);
    if (!allowed) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: `Missing permission: ${requirement.action} on "${requirement.resource}"`,
      });
    }
  });
}
