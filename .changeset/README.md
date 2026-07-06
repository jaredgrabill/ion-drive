# Changesets

Release management for the `@ionshift/*` packages ([changesets docs](https://github.com/changesets/changesets)).

The publishable packages — `core`, `admin`, `cli`, `client` — are a **fixed
group**: every release bumps all four to the same version (ADR-018 / Phase 14
Tier 0). `@ionshift/ion-drive-blocks` is ignored — blocks move to their own
repos and version independently (ADR-018 amendment).

Workflow:

1. `pnpm changeset` — describe your change (pick any package in the fixed
   group; the whole group bumps together).
2. `pnpm changeset version` — consumes pending changesets, bumps versions,
   writes changelogs.
3. Commit, then tag `v<version>` and push the tag — the `release` GitHub
   Actions workflow builds, packs, and publishes to npm + GHCR.
