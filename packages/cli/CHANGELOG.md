# @ion-drive/cli

## 0.5.0

### Patch Changes

- `init` golden path (#12): the scaffolded Postgres port is a single `ION_PG_PORT` knob (compose + `.env` + `DATABASE_URL`), with automatic free-port detection when 5432 is taken; docs cover calling the API from scripts (Origin header, API-key bootstrap).

## 0.4.1

### Patch Changes

- Security patch: the 0.4.0 artifacts were published from a tree that predates the framework-mode security audit fixes (V1–V7). 0.4.1 ships them all: scaffolded projects enforce auth by default (`ION_REQUIRE_AUTH=true` in the generated `.env`), production boot refuses to start with auth off unless `ION_ALLOW_OPEN=true`, wildcard credentialed CORS is refused at boot, signup locks after bootstrap via `ION_DISABLE_SIGNUP` (TOCTOU-safe, enforced inside the auth router), `/metrics` can be token-protected, and boot-time advisories warn about untrusted proxies and non-production mode. Also included: `ION_REQUIRE_AUTH=false` is now honored (was silently coerced to true), agent-facing docs spell out the role-bound API key MCP needs, and the MCP server reports its real version.

## 0.4.0

### Minor Changes

- Blocks registry ecosystem (Phase 18, specs 01–08 + 10, ADR-022/ADR-023).

  Core: registry protocol v1 (Zod schemas, parsers, generated JSON Schemas at `schemas/*.v1.json`), block manifest v1 (strict semver, `dependencies` ranges, `requires.core` enforced at install), manifest diffing + `BlockEngine.upgrade`, install provenance columns (`artifact_digest`, `trust_tier`, …).

  CLI: multi-registry config + `[@ns/]name[@selector]` refs with digest verification and sigstore trust tiers (`registry list/add/remove/ping`, `block verify`), the registry generator + publishing toolchain (`registry build/yank/deprecate`, `block new/validate/pack/publish`), ephemeral-server `block test` + `audit`, `diff`/`update` with the `.new`-file convention, `search`, registry MCP server (`ion-drive mcp`), and the iondrive.dev domain unification.

  Admin and client ride along via the fixed version group.

## 0.3.0

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
