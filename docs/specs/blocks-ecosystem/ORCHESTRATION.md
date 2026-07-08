# Phase 18 Orchestration Playbook — Agent Roles & Pipeline

How the blocks-ecosystem spec suite gets implemented by agents. The orchestrator (main
session) drives each spec through a three-role pipeline and lands one signed-off
`feat` commit per spec. **Scope of this run: M1 + M1.5 = specs 01–07.** Specs 08 (M2
site) and 09 (M3 hosted, draft) are out of scope — do not start them.

## Ground rules (bind every role)

- **The spec is the contract.** `docs/specs/blocks-ecosystem/spec-NN-*.md` defines the
  work; its **Acceptance criteria are the definition of done**. Read the suite
  `README.md` (cross-cutting rules, glossary) and ADR-022 before touching code. If the
  code contradicts the spec (drift since authoring), the implementer flags it, the
  orchestrator decides, and **the spec doc is amended in the same commit** — spec and
  code never diverge silently.
- **Two repos:** the platform monorepo (`I:\ion-shift\ion-drive`) and the official
  blocks repo (`I:\ion-shift\blocks`). Specs 02/05/06 land changes in both; commit in
  each repo separately. Never push; commits only.
- **Repo conventions apply in full** (see `CLAUDE.md`): Biome via `pnpm lint:fix`
  (repo is zero-errors *and* zero-warnings — keep it that way), strict TS, ESM `.js`
  relative imports, top-of-file JSDoc on every module (LLM legibility is a product
  goal), typed errors, surface parity (REST/OpenAPI/GraphQL/MCP move together — see
  `.claude/skills/surface-parity`).
- **Verification is real:** unit tests via `pnpm test`; integration via
  `pnpm test:integration` when the spec touches the server (dev Postgres is on
  **localhost:5433**, not 5432); live smokes numbered per `.claude/skills/live-smoke`
  where a spec's test plan calls for one.
- **Owner-run steps are collected, not attempted:** npm publishes, GitHub pushes of the
  blocks repo, Pages/DNS setup for `registry.iondrive.dev`, trusted-publisher/attestation
  registrations. Implement the workflows/config; record the human steps in a running
  `docs/specs/blocks-ecosystem/OWNER-TODO.md` checklist.

## Pipeline order

```
spec-01 → spec-02 → (spec-03 ∥ spec-04) → spec-05 → (spec-06 ∥ spec-07)
```

A spec never starts before everything in its "Depends on" line is signed off. The two
parallel pairs may run concurrently **only in isolated worktrees** (they meet in
`add.ts` / `registry-client.ts` — the orchestrator merges 03 first, then rebases 04's
work onto it); running them sequentially is the safe default if merge friction appears.

## Roles (all subagents on the Fable model; each starts cold — always pass full context)

Every agent prompt must include: the spec file path, `docs/specs/blocks-ecosystem/README.md`,
the ADR-022 section of `docs/research/architecture-decisions.md`, the repo path(s), and
the files named in the spec's Implementation notes. Agents must read the spec end-to-end
before acting.

### 1. Planner (read-only)

Reads the spec + the current code it touches. Produces: a step plan mapped 1:1 to the
spec's Design sections, the exact files to create/modify, test files to add, any
spec-vs-code conflicts or ambiguities (with a recommended resolution each), and what can
break. Does not write code. The orchestrator reviews the plan (sanity + scope) before
spawning the implementer; unresolvable ambiguities go to the user.

### 2. Implementer

Implements exactly to the spec + approved plan. Includes the spec's tests (the Test plan
section is part of the work, not optional). Runs `pnpm lint:fix`, `pnpm typecheck`,
`pnpm test` (+ integration when relevant) before reporting. Reports: what was built,
deviations from the spec (with reasons), test results verbatim, and anything left for
the verifier's attention. **No scope expansion** — adjacent improvements get noted, not
implemented.

### 3. Verifier (fresh agent — never the implementer)

Independently walks **every Acceptance criterion** in the spec, one by one, marking each
PASS/FAIL with evidence (test output, file citations, command results). Re-runs the full
gates: `pnpm lint` (zero errors/warnings), `pnpm typecheck`, `pnpm test`, integration/
live smoke where the spec's Test plan demands it. Checks the cross-cutting rules
(ownership contract, verification-before-vendoring ordering, surface parity, JSDoc
presence). Verdict: **SIGN-OFF** or **BOUNCE** with a numbered findings list.

Bounce loop: findings go back to the implementer (same agent via SendMessage, context
intact) for one fix round, then re-verify. If still failing after one bounce →
**stop the pipeline and summarize for the user**; do not loop indefinitely and do not
sign off a partial spec.

### 4. Sign-off commit (orchestrator)

Only after SIGN-OFF: one commit per repo touched —
`feat(<scope>): <summary> (spec-NN)` where scope ∈ `registry|blocks|cli|core` as
fits, body listing the acceptance criteria verified and any spec amendments, ending
with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Then append a
`> **Status:** ✅ implemented <date>, commit <shorthash>` line under the spec's title.

## Close-out (after spec-07 signs off)

Follow `.claude/skills/finish-phase`: update `CLAUDE.md` status (Phase 18 M1+M1.5
shipped), prune `docs/roadmap.md` Phase 18 accordingly, amend ADR-022 with anything
material learned, finalize `OWNER-TODO.md`, and report the full commit list + owner
checklist to the user. Do not push.
