/**
 * RBAC middleware — Fastify guards that enforce permissions using the engine.
 *
 * `requirePermission` is a preHandler factory for protecting individual routes.
 * `methodToAction` maps HTTP verbs to RBAC actions for the generic data/schema
 * surfaces, where the route handler is shared across verbs.
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { PermissionEngine } from './permission-engine.js';
import type { Action } from './policy-types.js';

/** Resource may be a fixed string or derived from the request (e.g. a path param). */
export type ResourceResolver = string | ((request: FastifyRequest) => string);

/** Maps an HTTP method to the RBAC action it represents. */
export function methodToAction(method: string): Action {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'read';
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'read';
  }
}

function resolveResource(resource: ResourceResolver, request: FastifyRequest): string {
  return typeof resource === 'function' ? resource(request) : resource;
}

/**
 * Builds a preHandler that requires the given action on the given resource.
 * Responds 401 if unauthenticated, 403 if the principal lacks the permission.
 *
 * The unauthenticated 401 is a deliberate rail (issue #8): guarded routes —
 * every admin/platform surface — never consult the permission engine for an
 * anonymous caller, so the built-in `public` role can never satisfy them no
 * matter what its grants say. Anonymous access exists only on the read data
 * surfaces via the global enforcement hook.
 */
export function requirePermission(
  engine: PermissionEngine,
  action: Action,
  resource: ResourceResolver,
): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }
    const res = resolveResource(resource, request);
    const allowed = await engine.can(request.auth, action, res);
    if (!allowed) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: `Missing permission: ${action} on "${res}"`,
      });
    }
  };
}
