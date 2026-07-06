# @ionshift/ion-drive-admin

The Ion Drive admin console — a prebuilt React SPA (schema designer, data
grid, users/roles, tasks, blocks, logs, metrics). This package ships only
static assets (`dist/`); install it next to `@ionshift/ion-drive-core` and
the server mounts it automatically at **`/admin`**.

```bash
pnpm add @ionshift/ion-drive-core @ionshift/ion-drive-admin
```

No exports, no runtime dependencies — it is resolved by the core server at
boot (override the location with `ION_ADMIN_DIST`; disable with
`ION_ADMIN_ENABLED=false`).

Docs & source: https://github.com/ionshift/ion-drive · License: Apache-2.0
