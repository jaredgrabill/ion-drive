/**
 * Boot-time and runtime security advisories (audit V6 / V7).
 *
 * These surface footguns that are safe to run with but dangerous to expose:
 *
 *   V6 — `/metrics` served without a token leaks operational detail; helmet's
 *        Content-Security-Policy is only enabled under `NODE_ENV=production`,
 *        so a deploy that never set `NODE_ENV` runs unhardened.
 *   V7 — with `trustProxy` off (the safe default against IP spoofing) but an
 *        actual reverse proxy in front, `request.ip` collapses to the proxy's
 *        address and every client shares one rate-limit bucket.
 *
 * The logic is pure and returns messages/booleans so `createServer` can log
 * them and tests can assert on them without capturing a logger.
 */

import type { FastifyInstance } from 'fastify';
import type { IonDriveConfig } from './config/index.js';

/** The slice of config the advisories inspect. */
export type AdvisoryConfig = Pick<
  IonDriveConfig,
  'metricsEnabled' | 'metricsToken' | 'nodeEnv' | 'trustProxy'
>;

/**
 * Collects boot-time security advisories to log at `warn` (audit V6). Each is a
 * complete, actionable sentence; an empty array means nothing to warn about.
 */
export function collectBootAdvisories(config: AdvisoryConfig): string[] {
  const advisories: string[] = [];

  if (config.metricsEnabled && !config.metricsToken) {
    advisories.push(
      'GET /metrics is served without authentication (ION_METRICS_TOKEN unset) — it exposes ' +
        'object names and traffic/error volumes. Protect it with ION_METRICS_TOKEN, keep it ' +
        'network-internal, or disable it with ION_METRICS_ENABLED=false.',
    );
  }

  if (config.nodeEnv !== 'production') {
    advisories.push(
      `Running with NODE_ENV=${config.nodeEnv}: helmet's Content-Security-Policy is disabled, logging is verbose, and GraphiQL is served. Set NODE_ENV=production for any exposed deployment.`,
    );
  }

  return advisories;
}

/**
 * True when a request presents an `X-Forwarded-For` header but the server does
 * not trust proxy headers (`trustProxy` is exactly `false`) — meaning
 * `request.ip` is the proxy's address and all clients collapse into one
 * rate-limit bucket (audit V7). A number/string `trustProxy` means a proxy is
 * configured, so no warning.
 */
export function isUntrustedForwardedFor(
  trustProxy: IonDriveConfig['trustProxy'],
  headers: Record<string, unknown>,
): boolean {
  return trustProxy === false && Boolean(headers['x-forwarded-for']);
}

/** The one-shot warning logged when {@link isUntrustedForwardedFor} first fires. */
export const UNTRUSTED_PROXY_WARNING =
  'Received X-Forwarded-For but ION_TRUST_PROXY is false — request.ip is the proxy address, so ' +
  'every client shares one rate-limit bucket (one actor can lock out everyone). Set ' +
  'ION_TRUST_PROXY to your proxy hop count (e.g. 1) or the proxy CIDR when behind a trusted proxy.';

/**
 * Logs the boot-time advisories (V6) and installs a one-shot `onRequest` hook
 * for the untrusted-proxy warning (V7). Called from `createServer` after the
 * security plugins are registered.
 */
export function installSecurityAdvisories(server: FastifyInstance, config: AdvisoryConfig): void {
  for (const advisory of collectBootAdvisories(config)) {
    server.log.warn(advisory);
  }

  let warned = false;
  server.addHook('onRequest', (request, _reply, done) => {
    if (!warned && isUntrustedForwardedFor(config.trustProxy, request.headers)) {
      warned = true;
      server.log.warn(UNTRUSTED_PROXY_WARNING);
    }
    done();
  });
}
