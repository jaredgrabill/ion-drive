/**
 * Content collections — the stock Starlight docs collection. The entries are
 * *generated*: `scripts/prepare-docs.mjs` copies the curated repo `docs/`
 * subset into `src/content/docs/docs/` (gitignored) before build/dev, adding
 * title frontmatter and rewriting links. The extra `docs/` path segment is
 * what yields the `/docs/**` routes.
 */

import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
