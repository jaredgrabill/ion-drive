# @ion-drive/core

## 0.4.0

### Minor Changes

- Blocks registry ecosystem (Phase 18, specs 01–08 + 10, ADR-022/ADR-023).

  Core: registry protocol v1 (Zod schemas, parsers, generated JSON Schemas at `schemas/*.v1.json`), block manifest v1 (strict semver, `dependencies` ranges, `requires.core` enforced at install), manifest diffing + `BlockEngine.upgrade`, install provenance columns (`artifact_digest`, `trust_tier`, …).

  CLI: multi-registry config + `[@ns/]name[@selector]` refs with digest verification and sigstore trust tiers (`registry list/add/remove/ping`, `block verify`), the registry generator + publishing toolchain (`registry build/yank/deprecate`, `block new/validate/pack/publish`), ephemeral-server `block test` + `audit`, `diff`/`update` with the `.new`-file convention, `search`, registry MCP server (`ion-drive mcp`), and the iondrive.dev domain unification.

  Admin and client ride along via the fixed version group.

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
