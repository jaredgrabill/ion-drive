/**
 * Session middleware — resolves the authenticated principal for every request.
 *
 * Installed directly on the root Fastify instance (not as an encapsulated
 * plugin) so the `onRequest` hook and the `request.auth` decorator apply to all
 * routes. Authentication is attempted API-key-first (Authorization: Bearer
 * iond_… or X-API-Key), then falls back to a provider session cookie.
 *
 * This layer only *identifies* the caller; enforcement lives in the RBAC
 * middleware, which reads `request.auth`.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { enterRequestContext } from '../runtime/request-context.js';
import type { ApiKeyManager } from './api-key-manager.js';
import type { AuthPrincipal, AuthProvider } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated principal, or `null` for anonymous requests. */
    auth: AuthPrincipal | null;
  }
}

export interface SessionMiddlewareOptions {
  provider: AuthProvider;
  apiKeys: ApiKeyManager;
}

function extractApiKey(headers: IncomingHttpHeaders): string | null {
  const authz = headers.authorization;
  if (typeof authz === 'string' && authz.toLowerCase().startsWith('bearer ')) {
    const token = authz.slice(7).trim();
    if (token.startsWith('iond_')) return token;
  }
  const header = headers['x-api-key'];
  if (typeof header === 'string' && header.startsWith('iond_')) return header;
  return null;
}

/**
 * Installs the session-resolution hook on the given (root) Fastify instance.
 * Must be called before route plugins are registered.
 */
export function installSessionMiddleware(
  fastify: FastifyInstance,
  options: SessionMiddlewareOptions,
): void {
  const { provider, apiKeys } = options;
  fastify.decorateRequest('auth', null);

  fastify.addHook('onRequest', async (request) => {
    const apiKey = extractApiKey(request.headers);
    if (apiKey) {
      const principal = await apiKeys.authenticate(apiKey);
      if (principal) {
        request.auth = {
          via: 'api_key',
          userId: principal.userId,
          user: null,
          session: null,
          apiKeyId: principal.apiKeyId,
          roleId: principal.roleId,
        };
      }
    }

    if (!request.auth) {
      const session = await provider.getSession(request.headers);
      if (session) {
        request.auth = {
          via: 'session',
          userId: session.user.id,
          user: session.user,
          session: session.session,
          apiKeyId: null,
          roleId: null,
        };
      }
    }

    // Make the actor ambient for the rest of this request's async chain
    // (Phase 12 / ADR-019) — DataService/SchemaManager read it for
    // created_by/updated_by, event payloads, and migration provenance.
    enterRequestContext(
      request.auth
        ? { userId: request.auth.userId, apiKeyId: request.auth.apiKeyId, via: request.auth.via }
        : null,
    );
  });
}
