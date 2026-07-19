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
 * **Anonymous requests** (issue #8): instead of an unconditional 401, requests
 * with no credential are evaluated against the built-in `public` role via
 * `engine.can(null, …)` — read-only by construction, so writes stay 401. Two
 * refinements keep public grants strictly per-object:
 *
 *   - `expand=` targets are checked too (via {@link EnforcementOptions.resolveExpandTarget}),
 *     so a grant on one object cannot hydrate ungranted neighbors; and
 *   - the GraphQL/MCP transports open for anonymous callers only when at least
 *     one public grant exists, with the per-object decision made inside the
 *     surface (per query field / per tool call) — their transport-level
 *     requirement (`read`/`manage` on `data`) is a platform resource the
 *     public role can never hold.
 *
 * Install this only when auth is required (config.requireAuth); when it is not,
 * the surfaces remain open for local development.
 */

import type { FastifyInstance } from 'fastify';
import { methodToAction } from './middleware.js';
import type { PermissionEngine } from './permission-engine.js';
import type { Action } from './policy-types.js';

export interface EnforcementOptions {
  /**
   * Maps an (object, relation key) pair to the target object an `expand=`
   * would hydrate, or null when the key is unknown (unknown keys are ignored
   * by the DataService, so they cannot leak). When absent, anonymous requests
   * carrying `expand=` are denied outright — fail closed.
   */
  resolveExpandTarget?: (objectName: string, relationKey: string) => string | null;
}

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

/** The relation keys an anonymous data request asks to expand (`?expand=a,b`). */
function requestedExpansions(url: string): string[] {
  const query = url.split('?')[1];
  if (!query) return [];
  return new URLSearchParams(query)
    .getAll('expand')
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether an anonymous request is allowed by the public role. Per-object for
 * the REST data surface (including `expand=` targets); transport-level for
 * GraphQL/MCP, where the per-object decision is made inside the surface.
 */
async function allowsAnonymous(
  engine: PermissionEngine,
  url: string,
  pathname: string,
  requirement: { action: Action; resource: string },
  options: EnforcementOptions,
): Promise<boolean> {
  if (pathname.startsWith('/api/v1/graphql') || pathname.startsWith('/api/v1/mcp')) {
    return engine.hasPublicReadGrants();
  }

  if (!(await engine.can(null, requirement.action, requirement.resource))) return false;

  // Per-object means expansions too: every expand target must also be
  // publicly readable. Unknown keys pass (the DataService ignores them).
  if (pathname.startsWith('/api/v1/data')) {
    const expansions = requestedExpansions(url);
    for (const key of expansions) {
      if (!options.resolveExpandTarget) return false; // no resolver — fail closed
      const target = options.resolveExpandTarget(requirement.resource, key);
      if (target && !(await engine.can(null, 'read', target))) return false;
    }
  }
  return true;
}

export function installRbacEnforcement(
  fastify: FastifyInstance,
  engine: PermissionEngine,
  options: EnforcementOptions = {},
): void {
  fastify.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? request.url;
    const method = request.method;
    if (isPublic(pathname, method)) return;

    const requirement = resolveRequirement(pathname, method);
    if (!requirement) return; // admin routes self-guard; everything else is public

    if (!request.auth) {
      // Anonymous: honored only for reads granted to the public role.
      if (await allowsAnonymous(engine, request.url, pathname, requirement, options)) return;
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
