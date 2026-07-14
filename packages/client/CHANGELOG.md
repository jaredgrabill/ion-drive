# @ion-drive/client

## 0.4.1

### Patch Changes

- Security patch: the 0.4.0 artifacts were published from a tree that predates the framework-mode security audit fixes (V1–V7). 0.4.1 ships them all: scaffolded projects enforce auth by default (`ION_REQUIRE_AUTH=true` in the generated `.env`), production boot refuses to start with auth off unless `ION_ALLOW_OPEN=true`, wildcard credentialed CORS is refused at boot, signup locks after bootstrap via `ION_DISABLE_SIGNUP` (TOCTOU-safe, enforced inside the auth router), `/metrics` can be token-protected, and boot-time advisories warn about untrusted proxies and non-production mode. Also included: `ION_REQUIRE_AUTH=false` is now honored (was silently coerced to true), agent-facing docs spell out the role-bound API key MCP needs, and the MCP server reports its real version.

## 0.4.0

## 0.3.0

## 0.2.0
