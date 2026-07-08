# @ion-drive/core

## 0.3.0

### Minor Changes

- Storage port + first-party plugin groundwork: new `StorageProvider` port with a
  filesystem `LocalStorage` default registered under `STORAGE_SERVICE`
  (`ION_STORAGE_DIR`, default `.ion-storage/`); `recordEventPublished`/
  `recordEventDelivery` and `ION_ATTR` are now public exports so external bus
  implementations keep `ion.event.*` telemetry parity; `PluginContext.bus`
  re-resolves live so plugins loading after a bus swap see the replacement.

### Patch Changes

- @ion-drive/admin@0.3.0

## 0.2.0

### Minor Changes

- 69f7537: Phase 14 (framework mode) groundwork:

  - Core serves the built admin console SPA at `/admin` (`ION_ADMIN_ENABLED`,
    `ION_ADMIN_DIST`), with SPA fallback, cache headers, and a root redirect.
  - Hardening knobs: `ION_TRUST_PROXY` (Fastify trustProxy), `ION_METRICS_TOKEN`
    (bearer-protected `/metrics`), `ION_DISABLE_SIGNUP` (close public signup
    once the first admin exists).
  - Packages are publishable: fixed-version group (core/admin/cli/client) via
    changesets; the CLI's bundled block catalog became optional (blocks move to
    their own repos per ADR-018).

### Patch Changes

- Updated dependencies [69f7537]
  - @ion-drive/admin@0.2.0
