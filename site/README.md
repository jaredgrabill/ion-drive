# site — iondrive.dev

The public static site (spec-10 / ADR-023 as amended): one Astro build, three
surfaces.

| Route | Surface |
|:---|:---|
| `/` | Project page ("Deep Field" design — zero JS beyond the theme script) |
| `/docs/**` | Starlight over the repo's **curated** `docs/` subset (see `scripts/prepare-docs.mjs` for the allowlist and why `research/`/`specs/`/phase plans stay unpublished) |
| `/blocks/**` | Client-rendered blocks browser (React island; reads the live registry JSON with a vendored copy of the CLI's protocol reader) |
| `/schemas/*.v1.json` | Canonical JSON Schemas, raw-byte-copied from `packages/core/schemas` at build time |

## Commands

```bash
pnpm --filter site dev        # prepare docs + astro dev server
pnpm --filter site build      # static build into site/dist
pnpm --filter site test       # vitest (jsdom + Testing Library)
pnpm --filter site typecheck  # astro sync + astro check + tsc
pnpm --filter site preview    # serve the built dist locally
```

Note: the root `pnpm dev` deliberately excludes this package
(`turbo run dev --filter=!site`) so platform development doesn't drag a docs
server along — use `pnpm --filter site dev` when working on the site.

Point the blocks browser at a fixture/preview registry with a build-time env
var: `PUBLIC_REGISTRY_URL=http://localhost:8765/registry/index.json`.

## Deployment

GitHub Pages is the primary host (`.github/workflows/site-deploy.yml`,
path-filtered to `site/**`, `docs/**`, `packages/core/schemas/**`). Render is
the documented optional alternative — everything Render-specific is isolated
in `render.yaml`. This package is `private: true`: never published to npm,
outside the changesets fixed group, excluded from the Docker image.
