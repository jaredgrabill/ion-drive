# Framework mode

Framework mode is Ion Drive's primary distribution model (ADR-018): instead of
cloning the platform or running an opaque container, you own a small project
that *composes* the platform from npm packages.

```
my-app/
  server.ts          ← your composition root (~20 lines)
  blocks/            ← vendored building blocks — your code
    index.ts         ← the explicit list of loaded blocks (the "barrel")
  ion/               ← typed client starter (@ion-drive/client)
  .env               ← configuration (generated secrets included)
  docker-compose.yml ← local PostgreSQL
  AGENTS.md          ← instructions for AI coding agents
```

`ion-drive init my-app` scaffolds all of this. `npm run dev` (tsx watch) boots
the whole backend — schema engine, REST/GraphQL/MCP APIs, auth, tasks, events,
and the admin console at `/admin` — and hot-reloads when you edit `server.ts`
or anything under `blocks/`.

## The composition root

`server.ts` is deliberately thin:

```ts
import { createServer } from '@ion-drive/core';
import { blocks } from './blocks/index.js';

const { server, config } = await createServer(undefined, { plugins: blocks });
await server.listen({ port: config.port, host: config.host });
```

`createServer(configOverrides?, { plugins })` is the **documented public API**:

1. Configuration is loaded from `ION_*` environment variables, merged with
   `configOverrides`.
2. Core services register their defaults (cache, email, logger, message bus).
3. Each plugin's `setup(ctx)` runs — it can replace a service via
   `ctx.registry.set(TOKEN, impl)` or register block action/hook handlers via
   `ctx.actions`.
4. Routes are wired; plugins' `onReady` runs.
5. You `listen()` on the returned `server`; `close()` (or SIGINT/SIGTERM)
   releases everything gracefully.

The returned handle exposes every assembled service (`schemaManager`,
`dataService`, `blockEngine`, `actionRegistry`, …) for programmatic use — see
the `IonDriveServer` type. The shapes of `CreateServerOptions`, the handle, and
the `IonPlugin`/`PluginContext` contracts follow semantic versioning.

## Plugins vs. blocks

The litmus test (ADR-018): **changes *how* the platform runs → plugin; changes
*what domain* it manages → block.**

- **Plugins** are sealed npm packages (a Redis cache/bus, a SendGrid mailer).
  You install them with your package manager and pass them to `createServer` —
  you never edit their code. Upgrades are `npm update`.
- **Blocks** are domain bundles (CRM, invoicing). Their *schema* installs
  through the server's APIs; their *logic* is vendored into `blocks/<name>/`
  shadcn-style — from that moment it is your code. Upgrades are user-driven
  diffs, never automatic overwrites.

This split is the ownership model: framework fixes arrive as dependency
updates without touching your code, and your business logic never blocks a
platform upgrade.

## The blocks barrel

`blocks/index.ts` is an explicit, greppable list — no directory scanning:

```ts
import type { IonPlugin } from '@ion-drive/core';
// ion-drive:imports
import invoicing from './invoicing/index.js';

export const blocks: IonPlugin[] = [
  // ion-drive:blocks
  invoicing,
];
```

`ion-drive add`/`remove` maintain the entries between the marker comments;
everything else in the file is yours. A block whose plugin throws during boot
fails fast with `Plugin "<name>" failed to load: …` naming the culprit.

## Two other ways to run Ion Drive

- **Container mode** — the published Docker image runs core + admin with zero
  code; ideal for evaluating or for schema-only workloads. See
  [Deploying with Docker](../deployment/docker.md).
- **Contributor mode** — clone the `jaredgrabill/ion-drive` monorepo and `pnpm dev`;
  for working on the platform itself. See [CONTRIBUTING](https://github.com/jaredgrabill/ion-drive/blob/main/CONTRIBUTING.md).
