# Spec 10 — The Project Page at `iondrive.dev`

**Lands in:** a **new repo `jaredgrabill/iondrive.dev`** (created locally at
`I:\ion-shift\iondrive.dev`, git-initialized, committed, never pushed — pushing and the
Render setup are owner-run). Small touches in `jaredgrabill/ion-drive` (docs links) ride
along.
**Depends on:** nothing hard (parallel-safe with spec-08); the **domain-unification
warm-up** (ADR-023: `ion-drive.dev` → `iondrive.dev` everywhere) must land first since
this site serves the canonical `/schemas/*` URLs.
**Implements the decisions in:** ADR-023.

## Scope

The public face of the project: a developer-first static site at the apex domain in the
style of good GitHub project pages (think Fastify/Vite/Biome project sites — README-grade
directness, no marketing fluff), deployed on **Render as a static site**, plus the
canonical JSON Schema hosting (`/schemas/*.v1.json`) and the redirect/header config.

## Non-goals

- A rendered documentation site. The repo's `docs/` stays canonical on GitHub; the page
  links into it. (A docs site is a later iteration — leave an obvious seam, e.g. a
  `/docs` path reserved via redirect to the GitHub docs tree.)
- A blog, newsletter capture, analytics beyond a privacy-respecting page counter (skip
  analytics entirely in v1).
- Rebuilding anything the M2 registry site does (`registry.iondrive.dev` owns block
  browsing; this page links to it).
- Dynamic anything. Static output only; portable off Render with nothing lost but
  redirects/headers.

## Design

### 1. Content (one long page + a few leaf pages)

Structured like a strong project README, in order:

1. **Hero** — name, one-sentence positioning (from CLAUDE.md: "self-hosted platform for
   accelerated custom business software development — define data objects at runtime,
   get REST/GraphQL/MCP APIs instantly"), the install one-liner
   (`npm i -g @ion-drive/cli && ion-drive init my-app`), GitHub link, license badge.
   A terminal-style animated snippet (CSS-only or tiny JS) showing
   `ion-drive init` → `ion-drive add crm` → curl of a live endpoint is the ideal hero
   visual — screenshots of the admin console are the fallback.
2. **The pitch, developer-voiced** — three or four short sections mapping to real
   surfaces: runtime schema → instant APIs (REST/GraphQL/MCP); building blocks
   (shadcn-style vendored code, digest-verified registry); agent-first (MCP everywhere,
   LLM-legible codebase); self-hosted/OSS (Apache-2.0, Postgres, single container).
   Each with a real, runnable code sample (query-language, client SDK, manifest
   snippet) — samples must be lifted from working docs, not invented.
3. **Feature grid** — dense, factual (schema designer, RBAC, events/webhooks/realtime,
   tasks, observability, plugins, multi-registry blocks…), each linking to the concept
   doc on GitHub.
4. **Quick start** — the `getting-started.md` opening steps inline, then "continue on
   GitHub".
5. **Ecosystem strip** — links: GitHub repo, `registry.iondrive.dev` (block registry),
   the blocks repo, npm packages.
6. **Footer** — IonShift Technologies LLC / trademark line (mirror `NOTICE`), license,
   `security@ionshiftlabs.com`.

Leaf pages/paths:
- **`/schemas/*.v1.json`** — the canonical JSON Schemas (ADR-023): copied from
  `packages/core/schemas/` with a drift-check documented in the repo README (re-copy on
  core release; same pattern as the blocks repo's mirror).
- **`/blocks`** → redirect to `https://registry.iondrive.dev/`.
- **`/docs`** → redirect to the GitHub `docs/` tree (the reserved seam).
- `404.html`, `favicon`, OG/social meta (title/description/OG image generated at build).

### 2. Look & feel

GitHub-project-page conventions, executed with intent: system font stack or one
self-hosted variable font, dark **and** light (respect `prefers-color-scheme`, offer a
toggle), the project's existing space-accent palette (`--ion-blue/purple/cyan` from the
admin's `index.css` — reuse the tokens, don't invent a second brand), real code samples
with syntax highlighting done **at build time** (no client-side highlighter). The
implementer must load the repo's `frontend-design` skill before writing markup and keep
the result out of "templated default" territory. Accessibility: keyboard nav, contrast
AA, `prefers-reduced-motion` honored by the hero animation.

### 3. Tech constraints

- TypeScript build tooling; **zero-framework runtime output** (plain HTML+CSS+minimal
  vanilla JS). Astro (static, zero-JS default) or a hand-rolled generator both qualify —
  same constraint set as spec-08's SSG; document the choice in the repo README.
- Performance budget: ≤ 100KB gz total transfer for the landing page excluding images;
  Lighthouse ≥ 95 across the board on a local run.
- **Render config in-repo**: `render.yaml` (static site: build command, publish dir,
  custom headers incl. long-cache for hashed assets + `X-Content-Type-Options`,
  redirects: `www.iondrive.dev` → apex, `/blocks`, `/docs`). Everything Render-specific
  isolated to that file so GitHub Pages remains a viable fallback (ADR-023).
- CI (GitHub Actions): build + link-check (internal anchors + the GitHub/registry URLs)
  + the schemas drift check. Render deploys on push to `main` (owner connects the repo).

### 4. Repo shape

```
iondrive.dev/
  README.md            # what this is, how to run/build, content-editing guide,
                       # schemas re-copy procedure, Render + DNS notes
  render.yaml
  package.json         # build/dev/check scripts
  src/ or site/        # generator input (pages, styles, components)
  public/schemas/*.v1.json
  .github/workflows/ci.yml
  LICENSE (Apache-2.0), NOTICE (mirror the platform repo's trademark notice)
```

## Implementation notes

- Copy real copy: positioning language comes from `README.md`/`CLAUDE.md`/ADR-017 —
  do not drift the product story. Code samples come from `docs/getting-started.md`,
  `docs/api/querying.md`, `docs/concepts/building-blocks.md`.
- The platform repo's `README.md` gains the site link; `docs/getting-started.md` header
  mentions it. (Two-line touches, ride the same run.)
- OG image: generate at build (SVG→PNG or a static asset) — dark background, logo
  wordmark, one-liner.
- The hero terminal animation must degrade to a static code block with JS disabled.

## Acceptance criteria

1. `pnpm build` (or equivalent) in the new repo emits a fully static tree; serving it
   with any static file server renders the complete page — no Render-only behavior
   except redirects/headers, which live only in `render.yaml`.
2. All six content sections render with real, source-attributed copy and working code
   samples; every outbound link resolves (link-check green in CI).
3. `/schemas/registry-index.v1.json` (and siblings) served byte-identical to
   `packages/core/schemas/*` — drift check proves it.
4. Dark and light both pass contrast AA on the hero + code samples; reduced-motion
   disables the terminal animation; Lighthouse ≥ 95 (performance/accessibility/best
   practices/SEO) on a local audit of the built output.
5. Landing page ≤ 100KB gz (excl. images), zero framework runtime, no client-side
   syntax highlighter, no external requests (fonts/assets self-hosted).
6. The repo is committed locally with CI green-by-construction (workflow runs are
   owner-gated); Render + DNS steps recorded in OWNER-TODO with exact settings
   (build command, publish dir, apex + www custom domains).

## Test plan

- CI: build + internal/external link check + schemas drift diff.
- Unit-level where the generator has logic (nav/anchor generation, OG meta).
- Manual review pass recorded in the run report: screenshots (dark + light + mobile
  width) via the browser tooling, Lighthouse scores, and the served-locally smoke
  (numbered, per the platform repo's live-smoke conventions).
