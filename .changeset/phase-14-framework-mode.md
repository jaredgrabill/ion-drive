---
'@ion-drive/core': minor
'@ion-drive/admin': minor
'@ion-drive/cli': minor
---

Phase 14 (framework mode) groundwork:

- Core serves the built admin console SPA at `/admin` (`ION_ADMIN_ENABLED`,
  `ION_ADMIN_DIST`), with SPA fallback, cache headers, and a root redirect.
- Hardening knobs: `ION_TRUST_PROXY` (Fastify trustProxy), `ION_METRICS_TOKEN`
  (bearer-protected `/metrics`), `ION_DISABLE_SIGNUP` (close public signup
  once the first admin exists).
- Packages are publishable: fixed-version group (core/admin/cli/client) via
  changesets; the CLI's bundled block catalog became optional (blocks move to
  their own repos per ADR-018).
