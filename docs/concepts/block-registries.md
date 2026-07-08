# Block Registries (protocol v1)

> **Status:** the wire format below (spec-01 of the blocks-ecosystem suite, ADR-022) is
> implemented in `@ion-drive/core`; publishing tooling (`ion-drive registry build`,
> `block publish`) and full publish/consume documentation ship with spec-05.

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
  "$schema": "https://ion-drive.dev/schemas/registry-index.v1.json",
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
  "$schema": "https://ion-drive.dev/schemas/registry-block.v1.json",
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

## Caching

- `index.json` and `blocks/<name>.json` are mutable: clients cache them with a short
  TTL (CLI default 5 minutes, `--no-cache` to bypass).
- Artifacts and attestation bundles are immutable: cacheable forever once the digest
  verifies. Hosts should serve them with
  `cache-control: public, max-age=31536000, immutable`.

## Validating registry files

`@ion-drive/core` exports the protocol as Zod schemas and parse helpers —
`registryIndexSchema` / `registryBlockSchema` / `registriesDirectorySchema` and
`parseRegistryIndex` / `parseRegistryBlock` / `parseRegistriesDirectory` (throwing
`RegistryParseError` with aggregated issues) — plus `resolveRegistryUrl` and
`isPermittedRegistryUrl`. Matching JSON Schema documents are declared at:

- `https://ion-drive.dev/schemas/registry-index.v1.json`
- `https://ion-drive.dev/schemas/registry-block.v1.json`
- `https://ion-drive.dev/schemas/registries-directory.v1.json`

These `$schema` URLs are declared-but-unresolvable until spec-05's Pages setup serves
them; the files are generated from the Zod schemas
(`pnpm --filter @ion-drive/core emit:schemas`) and live at `packages/core/schemas/`.
