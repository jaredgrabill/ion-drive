/**
 * Admin console static serving (Phase 14, Tier 1A).
 *
 * Serves the built admin SPA (`@ionshift/ion-drive-admin`'s `dist/`) from the
 * core server at `/admin`, so a scaffolded project — or the standalone Docker
 * image — gets the console with zero extra processes. Gated by
 * `ION_ADMIN_ENABLED` (default on) and mounted only when the assets are
 * actually present, keeping core fully usable headless.
 *
 * Resolution order for the assets directory:
 *   1. `ION_ADMIN_DIST` — an explicit path (monorepo dev: `packages/admin/dist`);
 *   2. the installed `@ionshift/ion-drive-admin` package (optional peer of core).
 *
 * Caching contract: HTML is `no-cache` (deploys take effect immediately);
 * Vite's content-hashed files under `assets/` are immutable for a year.
 * Any GET under `/admin` that matches no file falls back to `index.html`
 * (client-side routing), except paths that look like asset requests
 * (contain a dot in the last segment) — those 404 with the flat envelope so
 * a missing chunk fails loudly instead of returning HTML to the loader.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export interface AdminStaticOptions {
  /** Explicit path to the admin `dist/` directory (`ION_ADMIN_DIST`). */
  distPath?: string;
}

/**
 * Resolves the admin SPA's built assets directory, or null when the admin
 * package is not installed (or its `dist/` has no `index.html`).
 */
export function resolveAdminDist(explicitPath?: string): string | null {
  if (explicitPath) {
    return existsSync(path.join(explicitPath, 'index.html')) ? explicitPath : null;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('@ionshift/ion-drive-admin/package.json');
    const dist = path.join(path.dirname(pkgJson), 'dist');
    return existsSync(path.join(dist, 'index.html')) ? dist : null;
  } catch {
    return null;
  }
}

/**
 * True when a request path looks like a file request (last segment contains a
 * dot) rather than a client-side route — used to 404 missing assets instead of
 * serving them the SPA shell.
 */
export function looksLikeAssetPath(pathname: string): boolean {
  const lastSegment = pathname.split('/').pop() ?? '';
  return lastSegment.includes('.');
}

/**
 * Mounts the admin SPA at `/admin` (plus a convenience redirect from `/`).
 * Returns true when mounted, false when the assets could not be found —
 * the caller logs the outcome either way.
 */
export async function installAdminStatic(
  server: FastifyInstance,
  options: AdminStaticOptions = {},
): Promise<boolean> {
  const dist = resolveAdminDist(options.distPath);
  if (!dist) return false;

  await server.register(
    async (scope) => {
      await scope.register(fastifyStatic, {
        root: dist,
        prefix: '/',
        index: 'index.html',
        // We own cache-control per file below; `send`'s built-in header
        // (applied after setHeaders) would overwrite it otherwise.
        cacheControl: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('cache-control', 'no-cache');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            // Vite content-hashes everything under assets/ — safe to pin.
            res.setHeader('cache-control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('cache-control', 'public, max-age=0');
          }
        },
      });

      // SPA fallback: unknown paths under /admin are client-side routes.
      scope.setNotFoundHandler((request, reply) => {
        const pathname = request.url.split('?')[0] ?? request.url;
        if (request.method !== 'GET' || looksLikeAssetPath(pathname)) {
          return reply
            .code(404)
            .send({ error: 'Not Found', message: `Route ${request.method}:${pathname} not found` });
        }
        return reply.sendFile('index.html');
      });
    },
    { prefix: '/admin' },
  );

  // Convenience: the bare origin lands on the console.
  server.get('/', (_request, reply) => reply.redirect('/admin/', 302));

  return true;
}
