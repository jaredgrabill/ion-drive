# Contributing to Ion Drive

Thanks for your interest in Ion Drive! This guide covers how to get set up, the
conventions we follow, and how to propose changes.

## Getting set up

```bash
git clone https://github.com/jaredgrabill/ion-drive.git
cd ion-drive
pnpm install
docker compose -f docker/docker-compose.yml up -d   # Postgres for dev
pnpm dev
```

- **Requirements:** Node 22+, pnpm 9+, Docker.
- The repo is a **pnpm + Turborepo** monorepo; most commands fan out to every
  package.

## Repository layout

| Package | What it is |
|:---|:---|
| `packages/core` (`@ion-drive/core`) | Fastify backend: schema engine, dynamic REST/GraphQL/MCP APIs, auth/RBAC, secrets, telemetry, tasks, blocks, and the extensibility core (service registry + plugin host, message bus, provider ports). |
| `packages/admin` (`@ion-drive/admin`) | React 19 + Vite admin console. Pure API consumer. |
| `packages/cli` (`@ion-drive/cli`) | Space-themed CLI for project init and building blocks. |
| `packages/client` (`@ion-drive/client`) | Zero-dependency typed query builder + REST client SDK. |

The official building-block catalog lives in the separate
[`jaredgrabill/ion-drive-blocks`](https://github.com/jaredgrabill/ion-drive-blocks) repository (MIT licensed),
distributed through the block registry — see
[Building Blocks](docs/concepts/building-blocks.md).

See [CLAUDE.md](CLAUDE.md) and [docs/implementation_plan.md](docs/implementation_plan.md)
for a deeper map and current status.

## Everyday commands

```bash
pnpm test                              # unit tests (all packages)
pnpm --filter @ion-drive/core test     # one package
pnpm test:integration                  # requires Postgres
pnpm typecheck                         # tsc --noEmit everywhere
pnpm lint:fix                          # Biome check + autofix
pnpm build                             # tsc per package
```

## Conventions

- **Formatting & linting is Biome.** Single quotes, semicolons, trailing commas,
  2-space indent, 100-col width. Run `pnpm lint:fix` — don't hand-format. Imports
  are auto-organized.
- **ESM only.** Always use explicit `.js` extensions in relative imports (even
  from `.ts` source), and `import type` for type-only imports.
- **Strict TypeScript**, including `noUncheckedIndexedAccess` and
  `noUnusedLocals/Parameters`. Avoid `any` and non-null assertions (both are
  lint warnings).
- **Document modules.** Every module gets a top-of-file JSDoc block explaining
  its role. Match the surrounding density — readability for humans *and* LLMs is
  a product goal, not incidental.
- **Stateful services are classes** (`SchemaManager`, `DataService`); route
  generators are **plain functions returning Fastify plugins**
  (`registerXxxRoutes(...)`). Prefer custom typed errors over bare throws.
- **Keep the API surfaces in lockstep.** A capability added to REST should be
  reflected in GraphQL, MCP, and the OpenAPI spec — and, where relevant, the
  `@ion-drive/client` SDK.
- **Swap infrastructure via ports, not edits.** Cache, email, logging, and the
  message-bus transport are pluggable services resolved from a registry token; a
  plugin overrides them without touching core (see
  [docs/concepts/plugins.md](docs/concepts/plugins.md)). Record changes as
  CRUD/domain events on the message bus rather than hard-wiring cross-feature
  calls (see [docs/concepts/events.md](docs/concepts/events.md)).

## Architectural changes

The non-obvious technology choices (Fastify over NestJS, Kysely over
Prisma/Drizzle, graphql-js over Pothos, …) are deliberate and documented as ADRs
in [docs/research/architecture-decisions.md](docs/research/architecture-decisions.md).

If you make a real architectural decision:

1. Add a new ADR to that file.
2. Update [docs/implementation_plan.md](docs/implementation_plan.md) and the
   Status section of [CLAUDE.md](CLAUDE.md).
3. Flag it in your PR description.

Don't swap a load-bearing dependency without an ADR and a heads-up.

## Making a change

1. **Branch** from `main`.
2. **Write tests** — Vitest. Put `*.test.ts` next to the code. Cover the new
   behaviour and any edge cases.
3. **Verify locally:** `pnpm typecheck && pnpm lint:fix && pnpm test`. For
   backend changes that touch data or schema, run a quick live check against
   Postgres, not just unit tests.
4. **Keep docs current** — update the relevant file under `docs/` when you change
   behaviour (especially the query language, API surfaces, or config).
5. **Open a PR** with a clear description of the what and the why. Link any ADR.

## Commit & PR hygiene

- Keep commits focused and messages descriptive.
- CI runs lint, typecheck, and tests; keep them green.
- Small, reviewable PRs merge faster than large ones.

## Reporting bugs & requesting features

Open a GitHub issue with steps to reproduce (for bugs) or a concrete use case
(for features). For security issues, please disclose privately rather than in a
public issue.

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache 2.0](LICENSE) license (blocks in the separate `jaredgrabill/ion-drive-blocks`
repository are MIT). See [NOTICE](NOTICE) for trademark terms that apply to all packages.
