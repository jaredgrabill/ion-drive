# Block Registries (protocol v1)

> **Status:** the wire format below (spec-01 of the blocks-ecosystem suite, ADR-022) is
> implemented in `@ion-drive/core`, and the CLI consume side (spec-03: multi-registry
> config, namespaced refs, the range resolver, `ion-drive registry …`) is implemented;
> digest verification/trust badges (spec-04) and publishing tooling
> (`ion-drive registry build`, `block publish`, spec-05) ship next.

A **registry** is nothing more than a set of static JSON files served over HTTPS —
GitHub Pages, S3, Cloudflare Pages, or plain nginx all qualify. No server-side code is
ever required to *read* a registry. Clients reject `http:` registry URLs except for
`localhost`/`127.0.0.1` (local dev).

## The three file kinds

```
<registry root>/
  index.json               # the directory: name → summary + latest (for list/search)
  blocks/<name>.json       # one per block: full version history (for resolution)
  registries.json          # OPTIONAL, main registry only: directory of other registries
<artifact storage, anywhere>/
  …/<version>/block.json                # immutable artifact (the packed manifest)
  …/<version>/block.json.sigstore.json  # OPTIONAL attestation bundle, always adjacent
```

### `index.json` — the directory

Small on purpose: one summary entry per block, no version lists, no digests.

```json
{
  "$schema": "https://iondrive.dev/schemas/registry-index.v1.json",
  "schemaVersion": 1,
  "name": "Ion Drive Official Blocks",
  "generatedAt": "2026-07-08T00:00:00Z",
  "blocks": {
    "crm": {
      "title": "CRM",
      "latest": "0.2.0",
      "blockUrl": "blocks/crm.json",
      "trust": "official"
    }
  }
}
```

`schemaVersion` is required and must be literally `1` — an index without it is the
pre-release unversioned format and is rejected outright. `trust` is a display hint only;
real trust tiers are computed by the client (spec-04).

### `blocks/<name>.json` — the version history

The resolution and trust root. Each version entry carries `artifactUrl`, a
`digest` (`sha256:` + 64 lowercase hex over the exact artifact bytes), `size`,
`publishedAt`, mirrored `dependencies` (name → semver range) and `requires`
(at minimum `core` when declared) — so resolvers plan the whole dependency closure
without fetching a single artifact — plus an optional `attestationUrl` and a
`status` of `active` | `deprecated` | `yanked`.

```json
{
  "$schema": "https://iondrive.dev/schemas/registry-block.v1.json",
  "schemaVersion": 1,
  "name": "crm",
  "latest": "0.2.0",
  "versions": {
    "0.2.0": {
      "artifactUrl": "../../crm/dist/0.2.0/block.json",
      "digest": "sha256:<64 hex chars>",
      "size": 48213,
      "publishedAt": "2026-07-08T00:00:00Z",
      "dependencies": {},
      "requires": { "core": ">=0.2.0 <1.0.0" },
      "status": "active"
    }
  },
  "advisories": []
}
```

### `registries.json` — the registries directory (main registry only)

A PR-reviewed list mapping namespaces (`@acme`) to third-party registry index URLs.
`trust: "listed"` means exactly "reviewed for listing", **not** "code audited".

## The relative-URL rule

Every URL inside a registry file (`blockUrl`, `artifactUrl`, `attestationUrl`,
directory `url`s) may be relative; clients resolve it against the URL of the file it
appears in — `new URL(rel, urlOfContainingFile)`. `../../` traversal is legal (this is
URL space, not filesystem space). Absolute `https:` URLs are also allowed. Result: a
registry is host-portable — move the tree, nothing inside changes.

## Immutability, status, and advisories

- **Immutable once published:** a `(name, version)` entry's `artifactUrl`, `digest`,
  `size`, `publishedAt`, `dependencies`, `requires`, `attestationUrl` — and the artifact
  bytes themselves — never change. Fixing anything means publishing a new version.
- **Mutable by design:** `latest`, per-version `status`/`statusReason`/`yankedAt`,
  top-level `advisories`, and display metadata.
- **Status semantics:** `deprecated` versions install with a warning; `yanked` versions
  are never *selected* for a range or `latest` (exact re-installs of a version already
  recorded in the project keep working, with a warning). Yanking requires `yankedAt`.
- **Advisories** (`id`, `severity`, `affectedVersions` range, `description`,
  `createdAt`) are consumed by the resolver's warnings and `ion-drive audit`.
- **Malware exception:** a registry may delete a malicious artifact outright (the URL
  404s) — but must simultaneously mark the version `yanked` and publish an advisory, so
  consumers get a loud, explicable failure instead of silently installing malware.

## Consuming registries (spec-03)

Projects declare registries as **namespaces** in `ion.config.json` — a plain URL
string, or the object form for private registries:

```json
{
  "registries": {
    "@ion": "https://registry.iondrive.dev/registry/index.json",
    "@acme": {
      "url": "https://blocks.acme.internal/registry/index.json",
      "headers": { "Authorization": "Bearer ${ACME_REGISTRY_TOKEN}" },
      "params": { "token": "${ACME_REGISTRY_TOKEN}" }
    }
  },
  "defaultRegistry": "@ion"
}
```

- **`@ion` is built in** (present even with no `registries` key) and overridable by
  declaring it. `defaultRegistry` defaults to `@ion`; bare refs resolve there. The
  `ION_DRIVE_REGISTRY` env var overrides the default registry's URL for one invocation.
- **`${VAR}` auth**: `headers`/`params` values expand from the environment **at fetch
  time**; an unset variable is a hard, named error before any network call. `params`
  are appended to every request to that registry (the query-token pattern). Never put
  literal secrets in the file — it gets committed (the CLI warns).
- **Ref grammar**: `crm`, `crm@0.2.0`, `crm@^0.2`, `@acme/billing@1.x` — plus direct
  `https://…/block.json` URLs and local paths, unchanged.
- **The same-registry rule**: a block's bare dependency names resolve in the registry
  *that block* was resolved from — never the consumer's default, with no silent
  cross-registry fallback (the anti-dependency-confusion rule). `@ns/…` dependencies
  require `@ns` in your config. Two registries supplying the same bare name in one
  install plan is a hard error (blocks are singletons per server).
- **Resolution**: semver ranges are collected across the whole dependency closure
  (your CLI selector counts, as `required by you`) and the highest version with
  `status: active` satisfying **every** range is selected. `deprecated` installs with
  a warning; `yanked` is never auto-selected (an exact re-install of a version already
  recorded in `ion.config.json.blocks[]` stays allowed, loudly).
- **Commands**: `ion-drive registry list` (namespaces, block counts, staleness),
  `registry add <@ns> <url>` (validates the index before writing config),
  `registry remove <@ns>` (refuses while installed blocks came from it; `--force`),
  `registry ping [@ns]` — all with `--json`.

## Caching

- `index.json` and `blocks/<name>.json` are mutable: clients cache them with a short
  TTL (CLI default 5 minutes, `--no-cache` on `add`/`list` to bypass). The CLI keeps
  one file per registry at `~/.ion-drive/registry-cache/<sha256(indexUrl)>.json`
  (relocatable via `ION_DRIVE_CACHE_DIR`); auth headers/params are never written to
  disk.
- Artifacts and attestation bundles are immutable: cacheable forever once the digest
  verifies (the CLI does not cache them — they are verified-then-used in-process).
  Hosts should serve them with
  `cache-control: public, max-age=31536000, immutable`.

## Validating registry files

`@ion-drive/core` exports the protocol as Zod schemas and parse helpers —
`registryIndexSchema` / `registryBlockSchema` / `registriesDirectorySchema` and
`parseRegistryIndex` / `parseRegistryBlock` / `parseRegistriesDirectory` (throwing
`RegistryParseError` with aggregated issues) — plus `resolveRegistryUrl` and
`isPermittedRegistryUrl`. Matching JSON Schema documents are declared at:

- `https://iondrive.dev/schemas/registry-index.v1.json`
- `https://iondrive.dev/schemas/registry-block.v1.json`
- `https://iondrive.dev/schemas/registries-directory.v1.json`

These `$schema` URLs are declared-but-unresolvable until spec-05's Pages setup serves
them; the files are generated from the Zod schemas
(`pnpm --filter @ion-drive/core emit:schemas`) and live at `packages/core/schemas/`.
