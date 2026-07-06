/**
 * Inbound webhook routes (Phase 14, ADR-018) — `ALL /api/v1/hooks/:block/:hook`.
 *
 * Blocks with vendored logic receive third-party webhooks here (e.g. Stripe →
 * `/api/v1/hooks/invoicing/stripe`). Two deliberate differences from every
 * other surface:
 *
 *  - **Session-auth exempt.** Webhook providers can't log in; authenticity is
 *    the handler's job via provider signatures (HMAC over the raw bytes). The
 *    global RBAC enforcement hook leaves this prefix unguarded by design; the
 *    per-IP rate limiter still applies.
 *  - **Raw body.** Signature schemes sign the exact request bytes, so this
 *    plugin scope replaces the JSON parser with a buffer passthrough — the
 *    handler gets `rawBody: Buffer` and parses only after verification.
 *    Content-type parsers are encapsulated per Fastify plugin scope, so the
 *    rest of the server keeps normal JSON parsing.
 *
 * A hook only responds while its block is installed *and* declared the hook in
 * its manifest *and* its vendored code registered a handler — the same
 * three-part contract as actions (see blocks/action-executor.ts).
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { ActionError, type ActionExecutor } from '../blocks/action-executor.js';
import { sendActionError } from './block-routes.js';

export interface HookRoutesServices {
  actionExecutor: ActionExecutor;
}

const HOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export function registerHookRoutes(services: HookRoutesServices): FastifyPluginCallback {
  const { actionExecutor } = services;

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // Capture the raw bytes for every content type within this scope only.
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, parserDone) => {
      parserDone(null, body);
    });

    fastify.route<{ Params: { block: string; hook: string } }>({
      method: [...HOOK_METHODS],
      url: '/:block/:hook',
      handler: async (request, reply) => {
        try {
          const result = await actionExecutor.executeHook(
            request.params.block,
            request.params.hook,
            {
              method: request.method,
              headers: request.headers,
              query: (request.query ?? {}) as Record<string, unknown>,
              // GET/DELETE deliveries have no parsed body; normalise to empty.
              rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
            },
          );
          return reply.code(result.status).send(result.body);
        } catch (err) {
          if (err instanceof ActionError) return sendActionError(reply, err);
          throw err;
        }
      },
    });

    done();
  };
}
