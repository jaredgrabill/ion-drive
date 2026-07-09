# Spec 10 — `iondrive.dev`: Project Page, Docs Site, and Blocks Browser

> **Status:** ✅ implemented 2026-07-09, commit 56cfc8a; fresh-agent verifier
> sign-off.
> **Amendments adopted during implementation:**
> - **Docs pipeline:** Starlight's `docsSchema()` hard-requires `title` frontmatter
>   (no repo doc has any) and Astro does not rewrite file-relative `.md` links, so
>   the "content-collection loader pointing at `../docs`" is implemented as a
>   generated-tree pipeline: `scripts/prepare-docs.mjs` (allowlist copy into a
>   gitignored `src/content/docs/docs/` tree, H1→title extraction, link
>   rewrite/check with named `DocsCurationError`/`DocsLinkError`) feeding the stock
>   `docsLoader()`. Same invariants, one testable transform point, zero committed
>   mirror. 13 pre-existing links from curated docs to excluded targets were
>   rewritten in canonical `docs/` to absolute GitHub URLs.
> - **Versions:** Astro ~6.4 + Starlight ~0.39 + @astrojs/react ^5 (Astro 7 was
>   days old at implementation); Shiki `-default` GitHub theme variants (the plain
>   ones fail AA on comment gray); Starlight hover-prefetch disabled (zero-JS
>   budget).
> - **Deep links on Pages:** `404.astro` doubles as the `/blocks/*` SPA fallback
>   (client-rendered, no-SEO surface per the ADR-023 trade-off); `render.yaml`
>   carries the real rewrite for the optional Render host.
> - **OG image:** one committed brand `og.png` with per-page meta text (build-time
>   per-page generation dropped — heavy deps for a three-surface site).
> - **Install one-liner:** the docs' canonical `npx @ion-drive/cli init my-app`
>   (nothing invented) instead of the `npm i -g` variant.
> - **Root `pnpm dev`** filters out the site (`turbo run dev --filter=!site`) so
>   daily platform DX is unchanged; `pnpm --filter site dev` runs the site.
> - **Design:** owner-directed exploration (three candidate directions weighed)
>   selected "Deep Field" — near-monochrome black-and-white base, space theme as
>   restraint, an always-dark glowing hero terminal in both themes, ceremonial
>   purple→cyan gradient in exactly two display-size places, admin `--ion-*`
>   tokens copy-adapted with KEEP-IN-SYNC headers. Landing ≈53KB gz, Lighthouse
>   100/100/100/100.

> **Rewritten 2026-07-09 per the ADR-023 amendment:** one static site, three surfaces
> — project page, Starlight docs over the repo's `docs/`, and the client-rendered
> blocks browser (absorbing the browsing UI dropped from `registry.iondrive.dev`).
> Lives **in the ion-drive monorepo** (`site/`), not a separate repo.

**Lands in:** `jaredgrabill/ion-drive` (`site/` — a private workspace package,
excluded from the changesets fixed group and from npm publishing).
**Depends on:** the ADR-023 **domain-unification warm-up** (this site serves the
canonical `/schemas/*` URLs) and spec-08's registry emissions (`search-index.json`,
`readmeUrl`) for the browser's search + README panels — the browser must degrade
gracefully against registries without them.
**Implements the decisions in:** ADR-023 (as amended).

## Scope

The public face at the apex domain, deployed on **Render as a static site**: a
developer-first project page in the style of good GitHub project pages
(Fastify/Vite/Biome — README-grade directness, no marketing fluff), the documentation
rendered with **Astro + Starlight** directly from the repo's public `docs/` subset,
and a **blocks browser** — client-side JS/React crawling the live registry JSON the
same way the CLI's protocol reader does.

## Non-goals

- Any server or API. Static output only; portable off Render with nothing lost but
  redirects/headers (`render.yaml` is the only Render-specific file).
- Prerendered per-block pages built from a registry checkout (the browser reads the
  live registry at runtime — no site↔registry build coupling; a deploy-hook rebuild
  is a possible later upgrade, noted not built).
- Trust *verification* in the browser. It displays registry-asserted hints, digests,
  and advisories, and points at `ion-drive block verify` / `ion-drive add` for real
  verification (spec-04's client-computed-trust posture).
- A blog, analytics, newsletter capture.

## Design

### 1. Site structure (Astro + Starlight)

```
site/                      # workspace package "site" (private)
  astro.config.mjs         # Starlight integration; content from ../docs (curated)
  src/pages/index.astro    # the project page (landing)
  src/pages/blocks/…       # the blocks browser (React island(s))
  src/components/, styles/
  public/schemas/          # built from ../packages/core/schemas (build step, not a copy-commit)
  render.yaml              # at repo root or site/ — Render static: build cmd, publish dir,
                           # headers, redirects (www→apex), path-filtered builds
```

- **`/`** — the project page (content spec in §2).
- **`/docs/**`** — Starlight over a **curated subset** of the repo's `docs/`
  (`getting-started.md`, `concepts/**`, `api/**`, `deployment/**`; explicitly NOT
  `research/`, `specs/`, phase plans, roadmap). Docs stay canonical where they are —
  Starlight consumes them via a content-collection loader pointing at `../docs`;
  relative links between included docs must resolve (rewrite/check at build; a broken
  or excluded-target link fails the build with a named error).
- **`/blocks`** and **`/blocks/<name>`** — the browser (§3).
- **`/schemas/*.v1.json`** — canonical JSON Schemas, emitted into the build output
  from `packages/core/schemas/` (same-repo build step — no mirror, no drift).
- `404`, favicon, OG/social meta per page (OG image generated at build).

### 2. The project page

Structured like a strong project README, in order: hero (one-sentence positioning
from CLAUDE.md/README, the `npm i -g @ion-drive/cli && ion-drive init my-app`
one-liner, GitHub link, license badge; a CSS-first terminal-style animated snippet —
`init` → `add crm` → curl a live endpoint — degrading to a static code block);
three-or-four developer-voiced pitch sections mapping to real surfaces (runtime
schema → instant REST/GraphQL/MCP; vendored blocks + digest-verified registry;
agent-first; self-hosted OSS on Postgres) each with a **runnable sample lifted from
the docs, never invented**; a dense factual feature grid linking into `/docs`; quick
start inline; ecosystem strip (GitHub, registry, npm); footer (IonShift trademark
line per `NOTICE`, Apache-2.0, `security@ionshiftlabs.com`).

Look & feel: GitHub-project-page conventions executed with intent — reuse the admin's
existing space-accent tokens (`--ion-blue/purple/cyan` from `packages/admin/src/index.css`;
one brand, don't invent a second), dark **and** light (`prefers-color-scheme` +
toggle), build-time syntax highlighting (no client-side highlighter), self-hosted
font or system stack, `prefers-reduced-motion` honored. The implementer must load the
`frontend-design` skill before writing markup; any diagram follows `dataviz`.

Keep some of the space theme and black and while asthetic--minimal, clean, sexy and a bit of personality and fun for a developer audience. This will be the first look for a developer of the project. Consider some ideas and designs and weigh them out with a quick sub task.

### 3. The blocks browser

Client-rendered React island(s) reading `https://registry.iondrive.dev/registry/…`
at runtime (CORS: GH Pages serves `access-control-allow-origin: *`):

- **Directory** (`/blocks`) — cards from `index.json` (title, description,
  categories, latest, trust *hint* badge), category filter, client-side search over
  `search-index.json` when the index advertises `searchUrl` (spec-08), else substring
  over the index — the exact CLI fallback.
- **Block panel** (`/blocks/<name>`, client-routed) — from `blocks/<name>.json`:
  version table (version, publishedAt, truncated digest with copy button, status,
  advisory flags, attestation link when `attestationUrl` present), rendered README
  when `readmeUrl` present (sanitized markdown render), dependency list with links,
  `requires`, and the install snippet (`ion-drive add <name>`). Honest trust copy:
  hints displayed, "verify locally with `ion-drive block verify`" linked.
- **Registries directory** (`/blocks/registries`) — renders `registries.json` with
  the "listed ≠ audited" disclaimer and the PR submission process.
- The registry reader is a small local module **parity-tested against the CLI's
  fixtures** (same lenient rules as `packages/cli/src/registry/protocol.ts` — keep a
  KEEP-IN-SYNC comment both sides); registry base URL configurable at build time so
  the browser can be pointed at a fixture registry in tests and previews.
- Graceful degradation: registry unreachable ⇒ a clear offline notice (the rest of
  the site is unaffected); missing optional fields ⇒ sections omitted, never errors.

### 4. Tech constraints

- Astro + Starlight + React islands only where interactivity demands (the browser);
  the project page and docs ship **zero-JS** apart from the theme toggle/hero.
- Performance budget: landing page ≤ 100KB gz transfer excluding images; the browser
  island lazy-loads its JS on `/blocks` routes only. Lighthouse ≥ 95 across the board
  on a local audit (landing + one docs page).
- Accessibility: contrast AA both themes, keyboard nav, reduced-motion.
- Monorepo integration: `site` joins the pnpm workspace + turbo (`build`, `dev`,
  `check` tasks), Biome per repo conventions, excluded from changesets/publish and
  from the Docker image. Root `pnpm build`/`lint`/`typecheck` must stay green and
  reasonably fast (site build cacheable by turbo).
- **Deployment — GitHub Pages primary** (owner decision 2026-07-09; the ion-drive
  repo's Pages slot is free — the registry uses the *blocks* repo's): ship
  `.github/workflows/site-deploy.yml` (path-filtered to `site/**`, `docs/**`,
  `packages/core/schemas/**`; build `site/` → `actions/upload-pages-artifact` →
  `actions/deploy-pages`; `permissions: pages: write, id-token: write`). Apex via
  A/AAAA records; Pages auto-redirects apex↔www when both DNS records exist; accept
  Pages' default cache headers (same posture as the registry host). **Render remains
  the documented optional alternative**: keep `site/render.yaml` (static site config,
  www→apex redirect, long-cache headers) so switching is a connect-the-repo away —
  everything host-specific stays isolated to that file and the workflow.

## Implementation notes

- Copy real copy: positioning from `README.md`/`CLAUDE.md`/ADR-017; samples from
  `docs/getting-started.md`, `docs/api/querying.md`, `docs/concepts/building-blocks.md`.
- Docs curation is an explicit include list in the Astro config with a comment
  explaining why `research/`/`specs/` stay out.
- The platform `README.md` gains the site link; `docs/getting-started.md` header
  mentions it.
- CI: the site builds + link-checks in the existing `ci.yml` (new job or step);
  Render deploy connection is owner-run.

## Acceptance criteria

1. `pnpm --filter site build` emits a fully static tree; serving it with any static
   file server renders all three surfaces (Render-only behavior confined to
   `render.yaml`).
2. The docs surface renders the curated `docs/` subset with working inter-doc links
   and navigation; a link to an excluded/missing doc fails the build with a named
   error; excluded trees are absent from the output.
3. The blocks browser, pointed at a **local fixture registry** (protocol-v1 tree
   served over localhost), renders the directory, search (index + fallback), a block
   panel with version table/digests/advisories/README, and the registries directory;
   pointed at an unreachable registry it shows the offline notice with the rest of
   the site intact.
4. The browser's reader passes the CLI-parity fixture tests (lenient acceptance,
   legacy-index rejection message, relative-URL resolution).
5. `/schemas/*.v1.json` byte-identical to `packages/core/schemas/*` in the build
   output (build-step test, no committed mirror).
6. Landing page ≤ 100KB gz excl. images; browser JS loads only on `/blocks` routes;
   Lighthouse ≥ 95 (perf/a11y/best-practices/SEO) on landing + one docs page; dark
   and light pass contrast AA; reduced motion disables the hero animation.
7. Root `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` stay green with the
   new workspace package; the Pages deploy workflow is in-repo and coherent (verifier
   reads it line by line — running it is owner-gated); Pages enablement + DNS (and
   the optional Render alternative) recorded in OWNER-TODO with exact settings.

## Test plan

- Site unit/build tests: docs curation + link check, schemas emission byte-check,
  reader parity fixtures, browser component tests against fixture JSON (vitest +
  testing-library, the admin's rig pattern).
- Manual review pass recorded in the run report: dark/light/mobile screenshots via
  the browser tooling of all three surfaces (browser pointed at the local fixture
  registry), Lighthouse scores, and a numbered served-locally smoke.
