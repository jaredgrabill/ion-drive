# Ion Drive — Launch Plan: "Launch Now & Narrow Hard"

**Date:** 2026-07-13 · **Status: ACTIVE — this supersedes all phase work until Definition of
Done is met.** · Companion docs: [roadmap.md](roadmap.md) (backlog — now frozen, see Lane 2),
[specs/blocks-ecosystem/OWNER-TODO.md](specs/blocks-ecosystem/OWNER-TODO.md) (exact owner-run
commands for the activation chain).

## The decision

Analysis of the project (13 shipped phases, zero external users, nothing published) produced
one recommendation, adopted here:

> **LAUNCH NOW & NARROW HARD** — unblock F23 (npm/GHCR/blocks-repo publish), verify security
> defaults, hard-freeze all breadth, collapse the pitch to one wedge, get 5–10 real external
> users before writing another subsystem. Monetization is deferred indefinitely.

**The wedge (the only pitch, everywhere):**

> *The self-hostable, MCP-native backend an AI agent stands up in minutes — with domain
> blocks you own as editable code.*

Everything in this plan either ships that sentence to the world or is deleted from scope.

## How to execute this plan

This document is written to be handed to an agent as a goal ("execute docs/launch_plan.md").
Lanes run in order; steps inside a lane are numbered and sequential unless marked parallel.
Each step is tagged:

- **[AGENT]** — runnable by a coding agent in this repo (or the blocks repo checkout at
  `C:\home\work\ion-shift\ion-drive-blocks`).
- **[OWNER]** — needs the owner's hands (secrets, DNS, GitHub settings, posting publicly).
  The agent's job for these is to *prepare everything up to the button* and hand the owner an
  exact, copy-pasteable instruction, then verify the result afterwards.

Every step has acceptance criteria. Do not mark a step done without running its check. When a
lane completes, update the **Progress ledger** at the bottom of this file (date + evidence).

---

## Lane 0 — Preflight: verify, don't redo (all [AGENT], ~half a day)

The security defaults were already fixed (V1–V7, merged 2026-07-12 — see
[security-audit-2026-07-framework-mode.md](research/security-audit-2026-07-framework-mode.md)).
This lane *proves* the tree is publishable as-is; it writes no features.

1. **Full local gate.** `pnpm lint` (zero errors *and* warnings), `pnpm typecheck`,
   `pnpm test`, `pnpm test:integration` (against dev Postgres), `pnpm build` — all green from
   a clean `main`.
2. **Security posture spot-check on the scaffold.** `ion-drive init` a scratch project from
   packed tarballs; confirm the scaffolded `.env` has `ION_REQUIRE_AUTH=true`, boot in
   `NODE_ENV=production` with auth off **refuses** to start, wildcard credentialed CORS
   refuses at boot, and second-signup returns 403 after bootstrap. (These are the V1–V5
   fixes observed live, not re-derived from tests.)
3. **Release-guard dry run.** Trigger `release.yml` via `workflow_dispatch` (it runs the whole
   pipeline as a dry run): guards (tag/version match, no pending changesets, no cli→blocks
   runtime dep), build/test, publish steps in dry-run mode. Must be green.
   - Pre-check locally first: `.changeset/` has no pending changesets ✅ (verified
     2026-07-13); fixed-group packages all at **0.4.0**.
4. **Version-pin audit (known landmine).** The blocks repo's CI/publish workflows and
   OWNER-TODO install `@ion-drive/cli@^0.3 @ion-drive/core@^0.3` — `^0.3` does **not** match
   the 0.4.0 we will publish. Sweep both repos for `^0.3` / hardcoded `0.3` version
   references (workflows, scaffold templates, docs) and bump to `^0.4` (or `>=0.4 <1`).
   Also confirm the three independently-versioned plugins' peer ranges
   (`>=0.2.0 <1.0.0`) admit 0.4.0.
5. **Docker image sanity.** Build `docker/Dockerfile` locally; container boots, serves
   `/admin`, `/health` 200. (Rehearsed in Phase 14 — re-run once since the tree moved.)

**Lane 0 done when:** all five checks green, with any fixes committed to `main` and pushed.

---

## Lane 1 — Unblock F23: publish everything (the activation chain)

This is the OWNER-TODO sequencing, restated as a checklist. Exact commands live in
[OWNER-TODO.md](specs/blocks-ecosystem/OWNER-TODO.md) — that doc remains the source of truth
for command syntax; this lane is the tracking order.

1. **[OWNER] npm prerequisites.** `release.yml` publishes **tokenless** via npm
   Trusted Publishing (OIDC) — there is no `NPM_TOKEN` secret. Register a Trusted
   Publisher (owner `jaredgrabill`, repo `ion-drive`, workflow `release.yml`) for **all
   seven** packages: `@ion-drive/{core,cli,client,admin,plugin-redis,plugin-sendgrid,plugin-storage-s3}`.
   If npm won't accept a Trusted Publisher for a never-published name, first-publish
   each package once locally (`npm publish --access public` from `packages/<pkg>` after
   `pnpm build`), then wire the Trusted Publisher. GHCR needs no setup (built-in
   `GITHUB_TOKEN`).
2. **[OWNER] First publish.** Tag `v0.4.0` on `main` → `release.yml` publishes
   `@ion-drive/{core,cli,client,admin}` to npm (provenance) + the GHCR image
   (amd64+arm64).
   **[AGENT] verify:** `npm view @ion-drive/core version` → `0.4.0`; `npm i -g
   @ion-drive/cli` works on a clean machine/dir; `docker pull ghcr.io/jaredgrabill/ion-drive`
   boots and serves `/admin`.
3. **[OWNER] Push + tag the blocks repo** (`C:\home\work\ion-shift\ion-drive-blocks` →
   `jaredgrabill/ion-drive-blocks`, tag `v1` for the reusable workflow).
4. **[OWNER] Pages + DNS, both repos.** `registry.iondrive.dev` (blocks repo Pages, CNAME) and
   `iondrive.dev` (monorepo Pages, apex A/AAAA + www CNAME), enforce HTTPS.
   **[AGENT] verify:** the curl matrix in OWNER-TODO (registry index/blocks/artifact/schemas/
   registries.json; site landing, `/docs/getting-started/`, `/blocks/` incl. a deep link,
   `/schemas/*.v1.json`).
5. **[OWNER] Publish-workflow dry-run dispatch**, then **first attested publish** (AC3→AC4).
   **[AGENT] verify:** `gh attestation verify` per block; from a scratch project
   `ion-drive add crm` resolves via `registry.iondrive.dev`, digest-verifies, shows
   ◆ official; `ion-drive block verify crm@<version>` → digest OK, attestation OK, tier
   official. Then **[AGENT]** commit the produced sigstore bundles + artifact bytes as CLI
   test fixtures (closes spec-04 §1).
6. **[AGENT] Post-publish ecosystem smokes** (can interleave with 5): blocks-repo CI green on
   `main` for all five blocks (spec-06 AC1); the dogfood loop with the *published* CLI
   (spec-06 AC6); live badge/search/README checks (spec-08 AC5); `ion-drive search invoicing`
   hits the live index.
7. **[OWNER, deferrable] Third-party registry rehearsal** (spec-05 AC5). Nice-to-have for
   launch day; do not block Lane 3 on it.

**Lane 1 done when:** a stranger with Node 22 and Docker can run
`npx @ion-drive/cli init`, `ion-drive dev`, `ion-drive add crm`, and hit a live admin +
MCP endpoint — with zero access to our machines. That is the launch artifact.

---

## Lane 2 — Narrow hard: the breadth freeze ([AGENT], half a day)

Freeze scope *in writing* so future sessions (and agents) don't drift back into building.

1. **Declare the freeze in `roadmap.md`.** Add a banner at the top: Phases 15 (file field UX),
   16 (multi-tenancy), 17 (authz depth), the plugin-redis integration-test TODO, all §1.5
   admin polish, and every "deferred small item" under Phase 18 are **FROZEN until ≥5
   external users** (per this plan). Bugfixes, security issues, and launch blockers are
   exempt.
2. **The litmus test (record it in `CLAUDE.md`'s status section + `roadmap.md`):** new work is
   admissible only if it (a) makes the wedge sentence more true, (b) unblocks a real external
   user, or (c) fixes something broken. "A real user asked for it" beats any roadmap entry;
   no roadmap entry beats the freeze.
3. **Close the two one-liner stragglers** that are cheap and user-facing, then stop:
   the audit block's `changed_by: payload.actorId` mapping (blocks repo, one manifest line —
   fold into the Lane 1 blocks-repo push), and `CODE_OF_CONDUCT.md` (community hygiene for
   launch).
4. **Update `CLAUDE.md`** status section: link this plan as the active phase; note the freeze.

**Lane 2 done when:** roadmap + CLAUDE.md carry the freeze and the litmus test, committed.

---

## Lane 3 — Collapse the pitch: one wedge, five minutes ([AGENT] with [OWNER] review)

The product surfaces currently pitch a platform (schema engine + blocks + events + telemetry +
registry + …). Rewrite the front doors to pitch the wedge only. Feature breadth moves *below
the fold* — it's proof, not pitch.

1. **The 5-minute proof, timed and true.** Script the golden path and actually time it on a
   clean machine: `npx @ion-drive/cli init my-app` → `ion-drive dev` → connect a coding agent
   to `/api/v1/mcp` → the agent creates an object, inserts records, queries them → open
   `/admin` and see the data. If any step exceeds the promise (confusing prompt, missing
   default, unclear next action), fix *that* — this is the one place polish is in scope.
   Record the timing in the progress ledger.
2. **README.md hero rewrite.** First screen = the wedge sentence, the 4-command golden path,
   and one honest differentiator line ("your agent gets REST+GraphQL+MCP for free; blocks are
   code you own, not a marketplace lock-in"). Everything else moves down or out.
3. **Site landing (`site/`) rewrite** to the same hero + golden path. Keep the Deep Field
   design; change the words.
4. **`docs/getting-started.md`** — lead with the agent-first path (MCP + AGENTS.md scaffold),
   humans-with-curl second.
5. **The demo asset.** One terminal recording (or GIF) of the golden path start→data-in-admin,
   embedded in README + landing. Owner records or approves it.
6. **[OWNER] review pass** on all copy before it goes live (it ships with their name on it).

**Lane 3 done when:** README, landing, and getting-started all open with the wedge; the golden
path is timed under ~5 minutes from `npx` to data visible in `/admin`; demo asset embedded.

---

## Lane 4 — First users: 5–10 real external humans ([OWNER]-led, [AGENT]-supported)

No new subsystems until this lane closes. The deliverable is *evidence of use*, not traffic.

1. **[AGENT] Prep the landing zone:** enable-worthy GitHub settings list for the owner
   (Discussions on, issue templates verified, `SECURITY.md`/`CONTRIBUTING.md` linked from
   README), plus a pinned "Start here / report your first-run experience" discussion draft.
2. **[AGENT] Draft launch posts** for owner review — each keyed to the wedge, each with the
   golden path inline: Show HN, r/selfhosted, r/LocalLLaMA or MCP-community venues, an X/Bluesky
   thread, and the MCP servers directory listing (Ion Drive ships an MCP server — get it
   listed where agent builders already look).
3. **[OWNER] Post them.** Stagger over days; reply personally to every comment.
4. **Track users, not stars.** `docs/launch_log.md`: one row per external human who actually
   ran `init` (source, date, what they built, friction they hit, quotes). Stars/upvotes don't
   count as users.
5. **Feedback → fixes loop.** Friction reported by a real user jumps the queue over everything
   frozen in Lane 2. Ship fixes as patch releases (`v0.4.x`) — the release pipeline from
   Lane 1 makes this cheap. This is the whole reason the freeze exists: capacity to respond
   in hours.

**Lane 4 done when:** `docs/launch_log.md` has **5–10 distinct external users** with evidence
(a repo, a screenshot, a Discussion post, a bug report from their own run).

---

## Explicitly deferred (do not open until Lane 4 closes)

- **Monetization / hosted variant** — deferred indefinitely; not even a pricing page.
- **Phases 15–17** (file field UX, multi-tenancy, authz depth) and all Phase 18 leftovers not
  named in Lanes 0–3.
- New blocks, new plugins, new surfaces, benchmarks, admin polish.

## Definition of Done (the whole plan)

1. `@ion-drive/*@0.4.x` on npm + GHCR image public; registry + site live on `iondrive.dev`.
2. Security posture verified on the published artifacts (Lane 0 §2 re-run against npm
   installs, not tarballs).
3. Freeze recorded in roadmap + CLAUDE.md.
4. README/landing/getting-started open with the wedge; golden path timed ≤ ~5 min.
5. 5–10 external users logged with evidence.
6. A written go/no-go note on what those users actually did — the input to whatever gets
   unfrozen next. **Only then** does new subsystem work resume.

## Progress ledger

| Date | Lane/step | Evidence |
|:--|:--|:--|
| 2026-07-13 | Plan adopted | This document. |
| 2026-07-13 | Lane 0 §1 full local gate | lint 458 files clean; typecheck 10/10; unit 15/15 tasks; test:integration 10/10 (core 40 + cli 18) after fixing turbo strict-env stripping `ION_DATABASE_URL` (28dcf38); build 8/8. |
| 2026-07-13 | Lane 0 §2 security spot-check | Scaffold from 0.4.0 tarballs: `.env` has `ION_REQUIRE_AUTH=true`; prod+auth-off boot refused (exit 1, V1 message); `ION_CORS_ORIGINS=*` refused at boot (V2 message); signup #1 200 → signup #2 403 with `ION_DISABLE_SIGNUP=true`. Found+fixed: `requireAuth` used `z.coerce.boolean` so `ION_REQUIRE_AUTH=false` silently enforced auth (a28caee, regression-tested). |
| 2026-07-13 | Lane 0 §4 version-pin audit | Blocks repo already `^0.4` (dae3db5), zero `0.3` refs; monorepo's only `^0.3` was OWNER-TODO.md prose (fixed); plugin core peers `>=0.2.0 <1.0.0` admit 0.4.0. Stale `I:\ion-shift\blocks` path → `C:\home\work\ion-shift\ion-drive-blocks` in operational docs. |
| 2026-07-13 | Lane 0 §5 Docker sanity | `docker build docker/Dockerfile` green; container on scratch DB: `/health` 200, `/admin` 200 (SPA root served). |
| 2026-07-13 | Lane 0 §3 (prep) | Local pre-checks green: zero pending changesets, core/cli/client/admin all 0.4.0, no cli→blocks runtime dep. The `workflow_dispatch` itself was denied by the agent's permission layer — folded into the owner block (one `gh workflow run` command); agent verifies the run after. |
| 2026-07-13 | Lane 2 §1–2 freeze + litmus | Roadmap banner (Phases 15–17, plugin-redis test TODO, §1.5 polish, Phase 18 leftovers frozen until ≥5 external users) + litmus test recorded in roadmap.md and CLAUDE.md status. |
| 2026-07-13 | Lane 2 §3 stragglers | `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, contact = SECURITY.md address). Audit block `changed_by: payload.actorId` shipped as audit@0.1.1 in ion-drive-blocks (fa9ad95; block test 7/7). Incidental fix surfaced by the repack: `.gitattributes` now pins `*/code/**` `-text` — CRLF checkouts drifted every code-carrying artifact digest (a967a95). |
| 2026-07-14 | Lane 3 §1 (rehearsal) | Golden-path MCP leg rehearsed live on the 0.4.0-tarball scaffold: initialize → 17 tools → `create_object` → 3 × `create_record` → filtered `query_data` = exactly 2 rows (0.3s of API time). Friction found + fixed (2bbb09b): nothing documented that the agent's API key must be **role-bound** (AGENTS.md scaffold, init next-steps panel, docs/api/mcp.md now say so); MCP serverInfo reported hardcoded 0.1.0 → now the real package version. Clean-machine timing re-runs with the published CLI after Lane 1 §2. |
| 2026-07-14 | Lane 3 §2–4 (copy, pending review) | README hero, site landing (Hero/Terminal/index.astro), getting-started rewritten to the wedge + 4-command golden path, agent-first; getting-started curl examples now carry `X-API-Key` (they 401'd as written under the auth-on default). On **PR #5** awaiting the §6 owner review — merging deploys the site. Gate green (lint/typecheck/test; site 54 tests, 20 pages). |
| 2026-07-14 | Lane 3 §5 (asset built, pending approval) | `docs/assets/golden-path.svg` on PR #5 — self-contained CSS-animated terminal of the rehearsed golden path (17-tool count is real), embedded in the README hero; degrades to a static transcript, honors reduced motion. Owner approves on the PR, or records a GIF from the shot list in `docs/launch/posts.md` (1:1 swap). |
| 2026-07-14 | Lane 3 §5 (script) + Lane 4 §1–2, §4 (prep) | Demo-asset script drafted (owner records/approves); `docs/launch/landing-zone.md` (GitHub settings checklist + pinned first-run discussion draft), `docs/launch/posts.md` (Show HN, r/selfhosted, MCP-community, X/Bluesky thread, MCP directory listing — all owner-reviewed before posting), `docs/launch_log.md` scaffold (users + friction→fix ledger + go/no-go note). |
