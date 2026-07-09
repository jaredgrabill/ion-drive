/**
 * Astro integration wrapping `scripts/emit-schemas.mjs` (spec-10 AC5):
 *
 *  - `astro:build:done` — copies `packages/core/schemas/*.v1.json` raw-byte
 *    into `dist/schemas/`, so the canonical `iondrive.dev/schemas/*` URLs are
 *    byte-identical to core's published files. No committed mirror.
 *  - `astro:server:setup` — dev middleware serving `/schemas/*` straight from
 *    the source directory with `application/json`, so dev matches prod.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { defaultSchemasDir, emitSchemas } from '../../scripts/emit-schemas.mjs';

export function emitSchemasIntegration(): AstroIntegration {
  return {
    name: 'ion-drive:emit-schemas',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use('/schemas', (req, res, next) => {
          const name = (req.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
          // Schema names only — no separators, no traversal.
          if (!/^[\w.-]+\.v1\.json$/.test(name)) return next();
          readFile(path.join(defaultSchemasDir(), name))
            .then((bytes) => {
              res.setHeader('content-type', 'application/json');
              res.end(bytes);
            })
            .catch(() => next());
        });
      },
      'astro:build:done': ({ dir }) => {
        const outDir = path.join(fileURLToPath(dir), 'schemas');
        const { files } = emitSchemas(defaultSchemasDir(), outDir);
        console.log(`[emit-schemas] copied ${files.length} canonical schemas to /schemas`);
      },
    },
  };
}
