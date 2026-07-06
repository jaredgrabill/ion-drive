# Phase 14: Framework Mode & Vendored-Logic Blocks

**Decision record:** ADR-018 · **Roadmap items absorbed:** F20, F21, F22, F23, F24 (all of the
old "Phase 14 — Standalone developer experience" plus old Phase 11 item 6, the release pipeline).

> **Executes next**, despite the number: phases ship out of numeric order in this repo (9 before
> 8), and the roadmap's Phase 14 label is kept so F-number cross-references stay valid.

**Goal / definition of done:** the canonical user journey is real on a clean machine —

```
blank repo → ion-drive init → pnpm dev            # backend + admin console live, one command
           → ion-drive add crm                    # schema-only block, APIs light up
           → ion-drive add invoicing              # vendored logic lands in /blocks/invoicing
           → edit blocks/invoicing/stripe.ts      # hot-reload, it's YOUR code
           → POST /api/v1/blocks/invoicing/actions/create_payment_link   # works
```

— in under ten minutes, without talking to us. This loop is also the launch-gating demo
(README's "Ownership Model" section promises it; don't publicize before it's true).

---

## Tier 0 — Release pipeline (prerequisite) ✅ 2026-07-06 (first real publish pending — owner-run)

Nothing in this phase works until the packages are installable outside the monorepo. (F23)

- **Changesets** (or equivalent): versioning + changelogs; fixed/locked version across all
  `@ion-drive/*` packages per release — simplest to reason about; revisit independent versioning
  only if it earns its keep.
- **npm publish workflow** (GitHub Actions, tag-triggered): `core`, `admin` (must ship its built
  `dist/`), `cli`, `client`. **Not `blocks`** — per the ADR-018 amendment, blocks move to their
  own repos and distribute via the registry (Tier 4); the `cli → blocks` workspace dependency
  dissolves there. Verify publish order respects the remaining graph.
- **Docker image publish** for standalone mode (existing `docker/Dockerfile`).
- **Version-skew guard:** CLI warns when its catalog/scaffold expectations don't match the
  running server (`GET /api/v1/version` already exists).

**Verify:** `verdaccio` (or `npm pack` + `file:` installs) — install every package into a scratch
project and boot it. This local-registry rig is reused by every later tier's verification.

> **Shipped 2026-07-06** (with the security-checklist hardening warm-up: `ION_TRUST_PROXY`,
> `ION_METRICS_TOKEN`, `ION_DISABLE_SIGNUP`): changesets fixed group (blocks excluded,
> `private:true`), `release.yml` (guards + npm provenance + GHCR amd64/arm64; dispatch = dry run),
> packages publishable, CLI catalog optional + version-skew warning, root `.dockerignore` +
> Dockerfile prod-stage fixes. Verified via `pnpm pack` → scratch install (boots, `/admin` serves
> from the installed admin package) and a local image build/run. Remaining: owner sets `NPM_TOKEN`
> and pushes the first `v0.x` tag; bare-name block installs outside the monorepo stay unavailable
> until Tier 4's registry (by design — the interim fallback message points at URLs).

## Tier 1 — Core as an installable framework

### 1A: Serve the built admin SPA from core ✅ 2026-07-06

The single biggest gap between today's code and the vision — admin currently runs only via the
Vite dev proxy inside the monorepo.

- `@ion-drive/admin` publishes its `dist/`; core mounts it at **`/admin`** via
  `@fastify/static` (new dep), gated by `ION_ADMIN_ENABLED` (default on). SPA fallback to
  `index.html`; `no-cache` on the HTML, long-lived immutable caching on hashed assets.
- Admin resolution: optional peer — core looks up the admin package at runtime and logs a clear
  "admin not installed" when absent (keeps core usable headless).
- Audit `packages/admin/src/lib/api.ts` + router base path for same-origin serving under
  `/admin` (cookie auth should Just Work; the Vite proxy path stays for monorepo admin dev).
- Root `/` redirects to `/admin` when enabled.

> **Shipped 2026-07-06:** `core/src/api/admin-static.ts` (+11 unit tests), `ION_ADMIN_ENABLED`/
> `ION_ADMIN_DIST`, optional peer + workspace devDep resolution, vite `base:'/admin/'` + router
> `basepath` (dev server moves to `/admin/` too — one mental model), 12-check live smoke and an
> in-container check both green.

### 1B: Composition root + project-code loading ✅ 2026-07-06

- Promote `createServer(config, { plugins })` from "exists" to **documented public API**: export
  the option types, document lifecycle (`runReady`/`runShutdown`), and state the semver promise.
- **Explicit barrel over magic scanning:** the scaffolded `server.ts` imports `./blocks/index.js`
  — a generated barrel re-exporting each vendored block's plugin — and passes them to
  `createServer`. The CLI maintains the barrel on `add`/`remove`. (Rationale: greppable,
  agent-legible, no runtime fs scanning, no core changes needed. Core gains nothing magic.)
- Block module shape: each `/blocks/<name>/index.ts` default-exports a `definePlugin` (existing
  ADR-015 primitive) whose `setup` registers named handlers/actions (Tier 2 APIs).
- **Error isolation:** a throwing block plugin fails boot with "block `<name>` failed to load:
  …" naming the file — never a bare stack.

> **Shipped 2026-07-06:** `createServer` documented as the public API (`CreateServerOptions`,
> `IonDriveServer`, lifecycle + semver promise); plugin host wraps setup failures with the
> plugin's name; `PluginContext.actions` added; the scaffolded barrel uses
> `// ion-drive:imports` / `// ion-drive:blocks` markers maintained by the CLI.

## Tier 2 — The logic seam: actions, hooks, `requires` ✅ 2026-07-06

### 2A: Action + hook registries and catch-all routes

- New `blocks/action-registry.ts` registered in the service registry:
  `registerAction({ block, name, inputSchema, rbac?, handler })` and
  `registerHook({ block, name, handler })`. Handler context: `{ dataService, secrets, config,
  log, auth }` (mirrors task-handler context; extend, don't invent).
- **`POST /api/v1/blocks/:block/actions/:action`** — parameterized catch-all (same trick as
  `data-routes`, which is how we live with Fastify's no-routes-after-listen constraint). Zod
  input validation from the registered schema (400, flat error envelope), RBAC (default resource
  `blocks`, per-action override), per-invocation span + **`ion.action.*` metrics** (parity with
  `ion.task.*`), abort/timeout like task handlers.
- **`ALL /api/v1/hooks/:block/:hook`** — session-auth **exempt** (still rate-limited); handler
  receives raw body + headers for signature verification (Stripe-style). Raw-body capture needs a
  content-type parser tweak — scope it to this route prefix only.
- **Surface parity (convention, non-negotiable):** actions appear in OpenAPI (operation per
  action, schema from the manifest) and as MCP tools (`<block>_<action>`). GraphQL mutations for
  actions are *deferred* (note in docs; revisit with Phase 13's GraphQL work).

### 2B: Manifest extensions

- `blockManifestSchema` gains:
  - `actions: [{ name, description, input?, rbac? }]` — declares the public surface;
  - `requires: { handlers?: string[]; plugins?: string[] }` — declares what code must be present.
- **Installer validation:** every handler referenced by `actions`/`subscriptions`/`tasks` must be
  registered at install time; failure is an actionable error — *"block 'invoicing' requires
  handler 'stripe.create_payment_link' — did you vendor its code? (expected in
  /blocks/invoicing)"*. `preview` reports requirements the same way.
- Ledger (`_ion_blocks`) records the catalog version whose code was vendored at `add` time —
  the anchor for the future `diff`.

> **Shipped 2026-07-06:** `blocks/action-registry.ts` + `blocks/action-executor.ts` (shared
> resolve→validate→execute path: spans, `ion.action.*`/`ion.hook.*` metrics, abort/timeout);
> `POST /api/v1/blocks/:block/actions/:action` (per-action RBAC, default `update` on `blocks`);
> `GET /api/v1/blocks/actions`; `ALL /api/v1/hooks/:block/:hook` (session-exempt, scoped
> raw-body parser); OpenAPI operations + MCP `<block>_<action>` tools reflected per request.
> Manifest gains `actions`/`hooks`/`requires`/`code`; installer validates requirements first
> (hard error "did you vendor its code? (expected in /blocks/<name>)"; warnings in preview).
> GraphQL mutations deferred as planned.

## Tier 3 — CLI grows up ✅ 2026-07-06

### 3A: `init` scaffolds a real project (F21, F24)

Scaffold (never clobbers, per existing `scaffold.ts` discipline): `package.json` (deps
core+admin, scripts `dev`/`start`/`typecheck`), `tsconfig.json`, `server.ts`, empty
`blocks/index.ts` barrel, `.env` + `.env.example`, `docker-compose.yml` (Postgres only),
`.gitignore`, README, the existing `ion/` client starter, **and the agent-instructions layer**
(roadmap Part 3.2): an `AGENTS.md` template (MCP endpoint, query language, preview-first
schema-change contract, SDK idioms) plus starter skills `ion-schema-change` and `ion-add-block`.
The end user's first impression is deliberately minimal: an entrypoint and `/blocks` — everything
else lives in the npm deps.

### 3B: `add` vendors code (the two-part install)

- Block format grows an optional **`code/` directory** of TS templates alongside the manifest.
  `add` copies it to `/blocks/<name>/`, updates the barrel, *then* applies the manifest to the
  running server (as today — dependency resolution, preview, force flags unchanged).
- **Resolution sources:** the registry index by name (`ion-drive add crm[@version]`), a direct
  URL, or a **local path** (`ion-drive add ../block-crm`) — the local path is the dev loop for
  authoring blocks and for testing blocks against a working copy of core. The bundled-catalog
  resolution retires with `packages/blocks`.
- Re-`add` skips existing files and reports them — **never overwrites**.
- `remove` uninstalls the manifest and prints: *"blocks/<name> is your code now — delete the
  folder if you no longer want it."* (Server drops schema; the CLI never deletes user files.)

### 3C: `dev` runs the user's project (F20)

- In a scaffolded project (detected by the core dep / config file): ensure compose Postgres is
  up, then `tsx watch server.ts`. Editing vendored block code hot-reloads next to runtime schema
  changes — this loop **is** the product experience; treat polish here as feature work.
- Inside the monorepo, current contributor behavior is retained.

### 3D: `ion-drive diff <block>` (stretch — may slip to a follow-up)

Compare `/blocks/<name>` against the current catalog code (using the ledger-recorded base
version), per-file diff, `--take <file>` to accept. shadcn semantics: user-driven, never auto.

> **Shipped 2026-07-06:** `init [dir]` scaffolds the full project (composition root, marked
> barrel, generated secrets in `.env`, hardening knobs documented in `.env.example`, compose
> Postgres, AGENTS.md + `ion-schema-change`/`ion-add-block` starter skills, `ion/` client
> starter; `--config-only` keeps the old flow); `add` vendors `code/` → wires barrel → polls
> `GET /api/v1/blocks/actions` for the tsx reload → installs (re-add never overwrites);
> `remove` unwires the barrel + prints the your-code-now note; `dev` detects a project
> (`server.ts` + core dep) and runs compose-Postgres + `tsx watch server.ts`. 3D (`diff`)
> slipped to a follow-up as planned (ledger snapshots anchor it).

## Tier 4 — Blocks repo, the registry, and invoicing ↔ Stripe ✅ 2026-07-06

> **Executed under the ADR-018 re-amendment (owner decision): one `jaredgrabill/ion-drive-blocks` repo, not
> repo-per-block.** All four blocks (crm, invoicing, communications, audit) extracted to
> `I:\ion-shift\blocks` (git-initialized; push is owner-run) with the registry index at
> `registry/index.json` in the same repo; per-directory layout is identical to a third-party
> block repo. `ion-drive block new/validate/pack` toolchain shipped; CI = validate + pack +
> artifact drift guard. `packages/blocks` retired. The invoicing block vendors `code/stripe.ts`
> (zero-dep fetch client + HMAC signature verify w/ replay protection) + `code/index.ts`
> (action `create_payment_link` → Checkout session, stores link/session id, marks `sent`;
> hook `stripe` → verifies signature over raw bytes, marks `paid` on
> `checkout.session.completed`); `STRIPE_API_BASE` env override enables mock-based testing.

Per the ADR-018 amendment, blocks leave the monorepo. Official blocks use the exact same
distribution path a third-party block would.

### 4A: Block repos + authoring toolchain (F22 — now required, not ride-along)

- **Repo-per-block:** extract `crm`, `invoicing`, `communications`, `audit` into
  `jaredgrabill/block-<name>` — each containing the TS manifest source, emitted `block.json`,
  optional `code/`, README, and CI (manifest `validate` + emit drift + install smoke against a
  core container). Block repos depend on the *published* core for manifest types (Tier 0).
- **`ion-drive block new`** scaffolds that repo shape; **`ion-drive block validate`** runs the
  exported Zod parser + emit locally. This toolchain is how blocks get authored once the
  monorepo isn't the workshop.
- **Retire `packages/blocks`** once extraction lands (CLAUDE.md layout + docs updated).

### 4B: Registry

- Minimal **JSON index** (name → versions → artifact URL), hosted statically (small
  `jaredgrabill/block-registry` repo or a static site). CLI fetches + caches it; `list` reads it.
  No marketplace features — a flat file.

### 4C: First logic-bearing block: invoicing ↔ Stripe (the proof + launch demo)

- Vendored code (`code/` in `jaredgrabill/block-invoicing`): `stripe.ts` (client built from a
  `SecretsManager` key), action `create_payment_link`, hook `stripe` (signature verify → mark
  invoice paid via `DataService`), optionally a subscription handler on `data.invoices.create`.
- **Thin** (~200 lines target) and heavily commented — LLM legibility is the product; this file
  is what every evaluator (human or agent) will read first.
- Exercises end-to-end: registry + local-path resolution, `requires` validation, action surface
  parity (OpenAPI + MCP), secrets flow, session-exempt hook path, hot-reload editing.

## Tier 5 — Docs & monorepo DX ✅ 2026-07-06

- `docs/getting-started.md` rewritten **init-first**; README Quick Start gains the framework
  path as primary (contributor/monorepo path moves below it). "The Ownership Model" status
  callout updated when this ships.
- New: `docs/concepts/framework-mode.md`, `docs/api/actions.md`; block-authoring docs updated
  for `code/` + `actions`/`requires`.
- **Monorepo test rig:** an integration test (or `examples/` project) that runs the real `init`
  scaffold against workspace packages (pnpm overrides / verdaccio) so the framework path is
  CI-covered, not just hand-smoked. Admin development stays friendly: Vite proxy path unchanged.

> **Shipped 2026-07-06:** `getting-started.md` rewritten init-first (contributor path
> demoted to a callout); README Quick Start = scaffold → add blocks (ownership-model status
> updated to "implemented"); new `docs/concepts/framework-mode.md` + `docs/api/actions.md`;
> `building-blocks.md` rewritten for the two-part install/registry/authoring toolchain;
> CONTRIBUTING + the `new-block` skill updated for the blocks-repo workflow. Test rig:
> integration suite grew a Phase 14 test (requires validation incl. preview parity, action
> RBAC 401→200, declaration-gated 404, session-exempt raw-body hook, OpenAPI parity) and the
> CLI a scaffold-shape suite; CI-automating a full scaffold `npm install` boot stays a
> roadmap follow-up (the live loop covered it by hand).

## Out of scope (explicitly)

Sandboxed runtime-uploaded scripts (far-future "functions" phase); a block *marketplace*
(search/ratings/web UI — Tier 4B ships only the flat JSON index); GraphQL mutations for actions
(revisit with Phase 13); realtime/webhooks-as-product (Phase 12 — though the hooks catch-all
lays shared groundwork); multi-tenancy (Phase 16).

## Verification plan (live loop)

Clean scratch dir + local registry (verdaccio) or pnpm overrides:

1. `ion-drive init my-app` → `pnpm install` → `pnpm dev` → API on :3000, **admin at
   `/admin` loads**, first signup becomes admin.
2. `ion-drive add crm` → resolved from the registry index; manifest-only block installs; objects
   live on REST/GraphQL/MCP. Repeat once from a local path (`add ../block-crm`) to prove the
   block-dev loop.
3. `ion-drive add invoicing` → code lands in `/blocks/invoicing`, barrel updated, install
   passes `requires` validation; action visible in OpenAPI and as an MCP tool.
4. `POST /api/v1/blocks/invoicing/actions/create_payment_link` (Stripe test key via secrets) →
   200 with a link.
5. Simulated Stripe webhook to `/api/v1/hooks/invoicing/stripe` (signed) → invoice status flips;
   bad signature → 4xx.
6. Edit the vendored handler → tsx reload → changed behavior observed.
7. `ion-drive remove invoicing` → schema gone, ledger clean, CLI prints the your-code-now note.
8. RBAC: action route denied without permission when `ION_REQUIRE_AUTH=true`.
9. Root `pnpm test` green; new integration tests: action route validation/RBAC, `requires`
   failure message, admin static serving, scaffold boot.

## Sequencing

Tier 0 and 1A are independent starting points (parallelize). Then 1B → 2 → 3 → 4; docs (5)
continuous. `diff` (3D) slips first if anything must. ADR-018 is recorded; the finish-phase
ritual (ADR implementation notes, CLAUDE.md status, roadmap pruning, memory) applies as usual.
