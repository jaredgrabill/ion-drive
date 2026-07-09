// @ts-check
/**
 * iondrive.dev — one static site, three surfaces (spec-10 / ADR-023 amendment):
 *
 *  - `/`            the project page (zero JS beyond the theme pre-paint script)
 *  - `/docs/**`     Starlight over the curated repo `docs/` subset
 *                   (see scripts/prepare-docs.mjs for the allowlist + why
 *                   research/, specs/, phase plans, roadmap stay unpublished)
 *  - `/blocks/**`   the client-rendered blocks browser (React island)
 *  - `/schemas/*`   canonical JSON Schemas, raw-byte-copied from
 *                   `packages/core/schemas` at build time (never committed)
 */

import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { emitSchemasIntegration } from './src/integrations/emit-schemas.ts';

export default defineConfig({
  site: 'https://iondrive.dev',
  // Starlight would default this on; the spec's budget is zero JS on the
  // landing/docs beyond the theme script, so hover-prefetch stays off.
  prefetch: false,
  markdown: {
    // Dual Shiki themes; the landing <Code> panels use the same pair and the
    // dark palette is switched in by CSS (`[data-theme='dark'] .astro-code`).
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } },
  },
  integrations: [
    starlight({
      title: 'Ion Drive',
      description:
        'Open-source, self-hosted backend platform: runtime data objects with automatic REST, GraphQL, and MCP APIs.',
      customCss: ['./src/styles/tokens.css', './src/styles/starlight.css'],
      editLink: {
        // Content lives under src/content/docs/docs/**, so the collection-relative
        // path starts with `docs/` — exactly the repo path segment GitHub needs.
        baseUrl: 'https://github.com/jaredgrabill/ion-drive/edit/main/',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/jaredgrabill/ion-drive' },
      ],
      sidebar: [
        { label: 'Getting started', slug: 'docs/getting-started' },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'docs/concepts' } }] },
        { label: 'API', items: [{ autogenerate: { directory: 'docs/api' } }] },
        { label: 'Deployment', items: [{ autogenerate: { directory: 'docs/deployment' } }] },
      ],
      // The site ships its own 404 (the one full-starfield page, which doubles
      // as the /blocks/* deep-link fallback on GitHub Pages).
      disable404Route: true,
    }),
    react(),
    emitSchemasIntegration(),
  ],
});
