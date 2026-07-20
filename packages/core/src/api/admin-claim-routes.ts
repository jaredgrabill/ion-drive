/**
 * Admin claim routes (issue #32) — the first-login "claim" flow that follows
 * env-var admin bootstrap: `POST /api/v1/admin-claim` sets a real display name
 * and rotates the account off the `ION_ADMIN_PASSWORD` value, atomically
 * clearing the pending-claim marker (see auth/admin-claim.ts).
 *
 * The target account is derived EXCLUSIVELY from `request.auth` — never from
 * the request body, which carries no id/email field at all — so a tampered
 * body can never aim a claim at another account (issue #32 invariant 4).
 * Anonymous and API-key principals are rejected outright, regardless of any
 * role/permission they might otherwise carry (invariants 3 and 6): claiming
 * requires proof of the bootstrap credential, which only a real, session-
 * backed sign-in can provide.
 *
 * This plugin self-guards (like admin-routes.ts) and is registered
 * independently of the global RBAC enforcement hook (`installRbacEnforcement`
 * only recognizes `/api/v1/data`, `/api/v1/schema`, `/api/v1/graphql`,
 * `/api/v1/mcp` — see auth/rbac/enforcement.ts's `resolveRequirement`). That
 * means claim state can *only* ever affect these two routes: it structurally
 * cannot gate API-key access or the REST/GraphQL/MCP data surfaces (issue #32
 * invariant 8).
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminClaimNotPendingError, type AdminClaimService } from '../auth/admin-claim.js';
import { AdminClaimPasswordPolicyError } from '../auth/better-auth-adapter.js';

export interface AdminClaimRoutesOptions {
  claimService: AdminClaimService;
}

const claimBodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  newPassword: z.string().min(1, 'newPassword is required'),
  confirmPassword: z.string().min(1, 'confirmPassword is required'),
});

/**
 * Resolves the acting user id for the claim flow — a real, session-backed,
 * non-anonymous principal — or sends the appropriate error and returns null.
 * Deliberately narrower than the general RBAC guard: API keys and anonymous
 * sessions are refused here regardless of any role/permission they might
 * carry, because "claim" only means something for the interactive human
 * session that authenticated with the bootstrap credential.
 */
function resolveClaimant(request: FastifyRequest, reply: FastifyReply): string | null {
  const auth = request.auth;
  if (!auth || auth.via !== 'session' || !auth.userId) {
    reply.code(401).send({ error: 'Unauthorized', message: 'A signed-in session is required' });
    return null;
  }
  if (auth.user?.isAnonymous) {
    reply
      .code(403)
      .send({ error: 'Forbidden', message: 'Anonymous sessions cannot claim an account' });
    return null;
  }
  return auth.userId;
}

/** Maps a known `AdminClaimService` error to its HTTP status; re-throws anything else. */
function sendClaimError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AdminClaimNotPendingError) {
    return reply.code(err.statusCode).send({ error: 'Conflict', message: err.message });
  }
  if (err instanceof AdminClaimPasswordPolicyError) {
    return reply.code(err.statusCode).send({ error: 'Validation Error', message: err.message });
  }
  throw err;
}

export function registerAdminClaimRoutes(options: AdminClaimRoutesOptions): FastifyPluginCallback {
  const { claimService } = options;

  return (fastify: FastifyInstance, _opts: unknown, done: () => void) => {
    // Lets the admin SPA know whether to route to onboarding without a
    // mutation; harmless for any caller (it only ever reports the CALLER's
    // own state, never another account's).
    fastify.get('/admin-claim/status', async (request, reply) => {
      const userId = resolveClaimant(request, reply);
      if (!userId) return; // resolveClaimant already sent the error response
      return { pendingClaim: await claimService.isPendingClaim(userId) };
    });

    fastify.post('/admin-claim', async (request, reply) => {
      const userId = resolveClaimant(request, reply);
      if (!userId) return; // resolveClaimant already sent the error response

      const parsed = claimBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', issues: parsed.error.issues });
      }
      if (parsed.data.newPassword !== parsed.data.confirmPassword) {
        return reply
          .code(400)
          .send({ error: 'Validation Error', message: 'Passwords do not match' });
      }

      try {
        await claimService.completeClaim({
          // `userId` came from `request.auth` above — never from `request.body`,
          // which has no id/email field in its schema at all (invariant 4).
          userId,
          name: parsed.data.name,
          newPassword: parsed.data.newPassword,
        });
      } catch (err) {
        return sendClaimError(reply, err);
      }
      return reply.code(200).send({ success: true });
    });

    done();
  };
}
