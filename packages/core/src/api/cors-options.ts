/**
 * CORS configuration for the core server (audit V2 hardening).
 *
 * Ion Drive authenticates with cookies (the same-origin admin console) and API
 * keys, so cross-origin requests are always credentialed. That makes the
 * `origin: true` + `credentials: true` combination actively dangerous: with a
 * reflected `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials:
 * true`, *any* website an authenticated user visits can drive authenticated
 * requests on their behalf (cross-site data exfiltration / CSRF).
 *
 * {@link resolveCorsOptions} therefore:
 *   - **refuses** (throws at boot) a wildcard/reflecting origin (`true`, `'*'`,
 *     or an allowlist containing `'*'`) — there is no safe way to combine it
 *     with credentials;
 *   - defaults to **same-origin only** (`origin: false` — no ACAO header, so
 *     browsers block cross-origin credentialed access) when `ION_CORS_ORIGINS`
 *     is unset;
 *   - honours an **explicit allowlist** (one origin, or several via
 *     `createServer`) with credentials enabled.
 *
 * Credentials stay enabled in every allowed case so cookie auth works from the
 * permitted origins.
 */
import type { FastifyCorsOptions } from '@fastify/cors';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { IonDriveConfig } from '../config/index.js';

/** The slice of platform config the CORS layer consumes. */
export type CorsConfig = Pick<IonDriveConfig, 'corsOrigins'>;

/** True when `origins` reflects/permits every origin (`true`, `'*'`, or a list with `'*'`). */
function isWildcardOrigin(origins: CorsConfig['corsOrigins']): boolean {
  if (origins === true) return true;
  if (origins === '*') return true;
  return Array.isArray(origins) && origins.includes('*');
}

/**
 * Resolves safe `@fastify/cors` options from platform config, or throws when
 * the configuration would open the server to credentialed cross-site requests.
 * Pure and side-effect-free so it is unit-testable and can fail fast at boot.
 */
export function resolveCorsOptions(config: CorsConfig): FastifyCorsOptions {
  if (isWildcardOrigin(config.corsOrigins)) {
    throw new Error(
      'Unsafe CORS configuration: ION_CORS_ORIGINS reflects every origin ("true" or "*") ' +
        'while credentialed requests are enabled, which lets any website make authenticated ' +
        "calls on a logged-in user's behalf (cross-site request forgery / data exfiltration). " +
        'Set ION_CORS_ORIGINS to an explicit allowlist (e.g. https://app.example.com), or leave ' +
        'it unset for same-origin-only access.',
    );
  }
  // `false` (the default) → no Access-Control-Allow-Origin header at all, so
  // browsers permit only same-origin requests. Otherwise an explicit allowlist.
  return { origin: config.corsOrigins, credentials: true };
}

/**
 * Registers `@fastify/cors` with the resolved safe options. Called from
 * `createServer` alongside the other security plugins. Throws (via
 * {@link resolveCorsOptions}) before the server starts on an unsafe config.
 */
export async function installCors(server: FastifyInstance, config: CorsConfig): Promise<void> {
  await server.register(cors, resolveCorsOptions(config));
}
