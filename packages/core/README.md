# @ion-drive/core

The Ion Drive engine — a self-hosted application backend platform. Define
data objects, relationships, and logic **at runtime** and get REST, GraphQL,
OpenAPI, and MCP APIs instantly, plus auth/RBAC, secrets, scheduled tasks,
building blocks, events, and observability. Serves the admin console at
`/admin` when `@ion-drive/admin` is installed.

```ts
import { createServer } from '@ion-drive/core';

const { server, config } = await createServer();
await server.listen({ port: config.port, host: config.host });
```

Requires Node 22+ and PostgreSQL 17. Configuration is environment-driven
(`ION_*` variables — see the repo's `.env.example`).

Docs & source: https://github.com/jaredgrabill/ion-drive · License: Apache-2.0
