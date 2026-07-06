---
name: finish-phase
description: The close-out ritual for completing an implementation phase — verification, ADR, plan/CLAUDE.md status updates, roadmap pruning, memory, commit discipline.
---

# Finishing a phase

Run these steps **in order**. Every phase so far has followed this ritual; keeping the four
documents (ADRs, implementation plan, CLAUDE.md, roadmap) consistent is part of the work,
not an afterthought.

## 1. Full verification

```bash
pnpm test        # root — fans out to all packages
pnpm typecheck
pnpm lint        # Biome; zero errors (complexity *warnings* are known/tolerated)
pnpm build
```

Plus a **live smoke** against real Postgres — see the `live-smoke` skill. If the admin was
touched, check the initial bundle stays under the ~200KB gz budget (build output of
`pnpm --filter @ionshift/ion-drive-admin build`). Codify durable smoke checks as
`*.integration.test.ts` (run via `pnpm --filter @ionshift/ion-drive-core test:integration`).

## 2. New ADR

Append to `docs/research/architecture-decisions.md`. **Read the file tail first** for the
next number and the house format:

```
## ADR-0NN: <Title> (Phase N)

**Status:** Accepted (YYYY-MM-DD)
**Context:** …
**Decision:** … (may be several **Decision — <aspect>:** paragraphs)
**Consequences:** … (bullets)
```

Recent ADRs also carry an **Implementation notes (date, shipped):** section for deltas
discovered during implementation — record those; they're the most useful part later.

## 3. Status note in `docs/implementation_plan.md`

Mark the phase heading `✅ *Complete*` and add a `> [!NOTE]` block:
`> **Status: Complete (YYYY-MM-DD), verified end-to-end.** …` followed by dense bullets
(what shipped, where it lives, test counts, incidental fixes). Match the existing
Phase 6/7 blocks for tone and density.

## 4. Update `CLAUDE.md`

- **Current Status** section: add a `- **Phase N (<name>): DONE and verified …**` entry in
  the established dense-summary style (sub-bullets per area, real file paths, config vars,
  test counts, incidental fixes). Reference the new ADR.
- **Repository Layout / `packages/core/src` map**: add any new directories or major modules.
- **Known repo state** line: refresh if lint-warning counts or similar changed.

## 5. Prune `docs/roadmap.md`

It's the canonical backlog. Remove (don't strike through) findings and phase items this
phase shipped, and **add newly discovered deferrals** to the appropriate section (§1.5
polish backlog or a future phase). The roadmap's own header says: when a phase ships, move
its note into `implementation_plan.md`/`CLAUDE.md` and prune it here.

## 6. Record follow-ups in auto-memory

Add a `phase<N>-followups.md` memory file (and index it in `MEMORY.md`) with: deferred
tasks, non-obvious learnings/gotchas, and anything the next session would otherwise
re-derive (see the existing phase 8/9/10 follow-up files for the pattern).

## 7. Commit discipline

- Commit **only when the user asks**; **never push unprompted**.
- One coherent commit (or the split the user requested), message summarizing the phase.
- End commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Definition of done

All four docs tell the same story, tests/typecheck/lint/build pass at root, the live smoke
is reported as N/N, follow-ups are in memory, and nothing was pushed.
