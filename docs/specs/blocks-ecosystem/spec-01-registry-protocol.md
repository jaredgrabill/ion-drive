# Spec 01 — Registry Protocol v1

> **Status:** ✅ implemented 2026-07-08, commit af5dc64

**Lands in:** `jaredgrabill/ion-drive` (JSON Schemas + types) and
`jaredgrabill/ion-drive-blocks` (reference layout).
**Depends on:** nothing. Spec-02 (manifest v1) defines the artifact's *contents*; this
spec treats the artifact as opaque bytes.
**Implements the decisions in:** ADR-022.

## Scope

The wire format of an Ion Drive block registry: file layout, the JSON shapes of the
registry index, per-block version files, and the registries directory; URL resolution
rules; immutability, status, and advisory semantics; the `trust` field; published JSON
Schemas. This is the contract between *any* registry host (ours or third-party) and *any*
client (CLI, MCP tools, the M2 site generator, the M3 service's output).

## Non-goals

- How registries are *generated* (spec-05: `ion-drive registry build`).
- How clients *consume* the protocol (spec-03: resolution; spec-04: verification).
- Index signing / TUF-style root-of-trust for the registry files themselves (researched,
  deferred — see the research doc §"What we're not doing"). Artifact integrity comes from
  digests + attestations; the per-block file is the trust root and rides HTTPS.
- OCI distribution (noted as a future ADR option, à la Helm 3; do not build).

## Design

### 1. A registry is three kinds of static files

```
<registry root>/
  index.json               # the directory: name → summary + latest (for list/search)
  blocks/<name>.json       # one per block: full version history (for resolution)
  registries.json          # OPTIONAL, main registry only: directory of other registries
<artifact storage, anywhere>/
  …/<version>/block.json                # immutable artifact (opaque here; see spec-02)
  …/<version>/block.json.sigstore.json  # OPTIONAL attestation bundle, always adjacent
```

Requirements on the host: HTTPS, correct `content-type: application/json` (best-effort —
clients must not depend on it), and nothing else. GitHub Pages, raw git hosting, S3,
Cloudflare Pages, and nginx all qualify. **`http:` registry URLs are rejected by clients
except for `localhost`/`127.0.0.1`** (local dev).

The **reference layout** (what `registry build` emits and the official repo uses) puts
artifacts at `<name>/dist/<version>/block.json` next to the block's source directory.
That layout is a convention, not protocol: clients follow URLs, never guess paths.

### 2. URL resolution rule

Every URL inside a registry file (`blockUrl`, `artifactUrl`, `attestationUrl`, directory
`url`s) may be **relative**; clients MUST resolve it against the URL of the file it
appears in, i.e. `new URL(rel, urlOfContainingFile)`. Absolute `https:` URLs are allowed
(e.g. artifacts on a CDN while the index lives on Pages). This makes a registry
host-portable: move the tree, nothing inside changes.

### 3. `index.json` — the directory

```json
{
  "$schema": "https://ion-drive.dev/schemas/registry-index.v1.json",
  "schemaVersion": 1,
  "name": "Ion Drive Official Blocks",
  "description": "The main Ion Drive block registry.",
  "homepage": "https://registry.iondrive.dev",
  "generatedAt": "2026-07-08T00:00:00Z",
  "blocks": {
    "crm": {
      "title": "CRM",
      "description": "Companies, contacts, deals, and activities.",
      "categories": ["sales", "crm"],
      "latest": "0.2.0",
      "blockUrl": "blocks/crm.json",
      "trust": "official"
    }
  }
}
```

- `schemaVersion` (required, literal `1`) — clients MUST reject any other value with
  an actionable error ("this registry uses an unsupported format"). Today's interim (unversioned) index has
  no `schemaVersion`; absence ⇒ rejection ("registry is in the pre-release unversioned format —
  ask its owner to run `ion-drive registry build`").
- `name` (required), `description`/`homepage` (optional) — registry-level metadata,
  shown by `ion-drive registry list` and the M2 site.
- `generatedAt` (required, ISO-8601 UTC) — regenerated on every build; cache-busting
  signal and staleness display.
- `blocks` (required, may be empty) — **summary only**. `latest` and `blockUrl`
  (required per entry) are the only load-bearing fields; the rest is display. Keys match
  the manifest `name` grammar (spec-02). The index carries **no version lists and no
  digests** — that's the per-block file's job; this file must stay small (Helm's
  monolithic `index.yaml` scaling failure is the anti-pattern).
- `trust` (optional, `"official"`) — display hint only; on third-party registries clients
  ignore it for anything except display (spec-04 computes real trust).

### 4. `blocks/<name>.json` — the version history

```json
{
  "$schema": "https://ion-drive.dev/schemas/registry-block.v1.json",
  "schemaVersion": 1,
  "name": "crm",
  "title": "CRM",
  "description": "Companies, contacts, deals, and activities.",
  "categories": ["sales", "crm"],
  "repository": "https://github.com/jaredgrabill/ion-drive-blocks",
  "homepage": "https://registry.iondrive.dev/blocks/crm",
  "latest": "0.2.0",
  "versions": {
    "0.2.0": {
      "artifactUrl": "../../crm/dist/0.2.0/block.json",
      "digest": "sha256:ab12…64 hex chars…",
      "size": 48213,
      "publishedAt": "2026-07-08T00:00:00Z",
      "dependencies": {},
      "requires": { "core": ">=0.2.0 <1.0.0" },
      "attestationUrl": "../../crm/dist/0.2.0/block.json.sigstore.json",
      "status": "active"
    },
    "0.1.0": {
      "artifactUrl": "../../crm/dist/0.1.0/block.json",
      "digest": "sha256:cd34…",
      "size": 40110,
      "publishedAt": "2026-07-01T00:00:00Z",
      "dependencies": {},
      "requires": {},
      "status": "deprecated",
      "statusReason": "Superseded by 0.2.0 (renamed pipeline stages)."
    }
  },
  "advisories": []
}
```

Per-version entry fields:

| Field | Req | Meaning |
|---|---|---|
| `artifactUrl` | ✔ | The immutable artifact. Relative-or-absolute per §2. |
| `digest` | ✔ | `sha256:<64 lowercase hex>` over the **exact artifact bytes** (spec-04). |
| `size` | ✔ | Artifact byte length (pre-download sanity + UX). |
| `publishedAt` | ✔ | ISO-8601 UTC. The protocol's timestamp of record. |
| `dependencies` | ✔ | Mirror of the manifest's `dependencies` (name → semver range, spec-02) so resolvers plan the closure **without fetching artifacts**. |
| `requires` | ✔ | Mirror of manifest `requires` — at minimum `core` (semver range) when declared; may include `handlers`/`plugins` counts or lists for display. |
| `attestationUrl` | — | Sigstore bundle adjacent to the artifact. Absent ⇒ unattested (community tier). |
| `status` | ✔ | `active` \| `deprecated` \| `yanked`. |
| `statusReason`, `yankedAt` | — | Human context; `yankedAt` required when yanked. |

`advisories[]` (top-level, mutable):

```json
{
  "id": "IONB-2026-0001",
  "severity": "critical",
  "affectedVersions": "<0.2.1",
  "description": "0.2.0 shipped a webhook handler that logged raw Stripe payloads.",
  "url": "https://github.com/jaredgrabill/ion-drive-blocks/security/advisories/…",
  "createdAt": "2026-07-08T00:00:00Z"
}
```

`severity`: `low|moderate|high|critical`. `affectedVersions` is a semver range. Consumed
by `ion-drive audit` (spec-06) and the resolver's warnings (spec-03).

### 5. Immutability, status, and the malware exception

- Once published, a `(name, version)` entry's `artifactUrl`, `digest`, `size`,
  `publishedAt`, `dependencies`, `requires`, and `attestationUrl` **never change**, and
  the artifact bytes at `artifactUrl` never change. Republishing a version is forbidden;
  fixing anything means publishing a new version.
- Mutable by design: `latest`, per-version `status`/`statusReason`/`yankedAt`,
  top-level `advisories`, and all display metadata (title/description/categories/…).
- Status semantics for clients (enforced in spec-03/04, stated here as protocol):
  - `deprecated` — resolvable and installable; clients warn.
  - `yanked` — resolvers MUST refuse to *select* it (never chosen for a range or
    `latest`), MUST allow exact re-installs of a version already recorded in the
    project's `ion.config.json` (existing deployments keep working), and always warn.
- **Malware exception**: a registry MAY delete a malicious artifact outright (the URL
   404s). It MUST simultaneously mark the version `yanked` and publish an advisory.
  Consumers see a loud, explicable failure instead of silently installing malware.
- A git-hosted registry is immutable only by convention; the reference repo's CI enforces
  it (spec-05: fail any PR that changes bytes under an existing `dist/<version>/`).
  Digests recorded in every consumer's `ion.config.json` make out-of-band mutation
  loudly detectable at the next `add`/`audit`.

### 6. `registries.json` — the registries directory (main registry only)

```json
{
  "$schema": "https://ion-drive.dev/schemas/registries-directory.v1.json",
  "schemaVersion": 1,
  "registries": [
    {
      "namespace": "@ion",
      "url": "https://registry.iondrive.dev/index.json",
      "owner": "IonShift Labs",
      "repository": "https://github.com/jaredgrabill/ion-drive-blocks",
      "description": "Official Ion Drive blocks.",
      "trust": "official"
    },
    {
      "namespace": "@acme",
      "url": "https://blocks.acme.dev/registry/index.json",
      "owner": "Acme Corp",
      "description": "Acme's public Ion Drive blocks.",
      "trust": "listed"
    }
  ]
}
```

The shadcn `registries.json` model: inclusion via PR to the main registry repo, human
review (public HTTPS URL, valid v1 index, no name-grabbing namespaces, working contact).
`trust: "listed"` means exactly "reviewed for listing", not "code audited" — the docs and
site must say so. Consumed by `ion-drive registry add @acme` discovery and `ion-drive
search` (specs 03/08). Namespace collisions are first-come-first-served with the review
gate; disputes are resolved by the maintainers (M3 formalizes a name policy).

### 7. Caching guidance (normative for clients)

- `index.json` and `blocks/<name>.json`: cacheable with a short TTL (CLI default 5 min,
  `--no-cache` bypass). They are mutable.
- Artifacts and attestation bundles: **immutable** — cacheable forever once the digest
  verifies. Hosts SHOULD serve them with `cache-control: public, max-age=31536000,
  immutable` (the Pages config in spec-05 does).

### 8. Published JSON Schemas

Three 2020-12 JSON Schemas, authored in the ion-drive repo and published at:

- `https://ion-drive.dev/schemas/registry-index.v1.json`
- `https://ion-drive.dev/schemas/registry-block.v1.json`
- `https://ion-drive.dev/schemas/registries-directory.v1.json`

(Manifest schema `block-manifest.v1.json` ships with spec-02.) Until the domain serves
them, the `$schema` URLs are declared-but-unresolvable (same as today's manifest
`$schema`) — publishing them is part of spec-05's Pages setup (`/schemas/*` on the same
site). Schemas are additionally exported from `@ion-drive/core` as Zod objects
(`registryIndexSchema`, `registryBlockSchema`, `registriesDirectorySchema`) in a new
`packages/core/src/blocks/registry-types.ts`, so the CLI, `registry build`, the site
generator, and the M3 service all validate with the same code. JSON Schema files are
generated from Zod (`zod-to-json-schema`) by a build script and drift-guarded by a test.

## Implementation notes

- New file `packages/core/src/blocks/registry-types.ts`: the three Zod schemas + inferred
  types + `parseRegistryIndex`/`parseRegistryBlock` helpers (aggregate issues, same error
  style as `parseManifest` in `block-manifest.ts`). Export from
  `packages/core/src/index.ts`.
- Digest/semver formats are validated here structurally (`sha256:` + 64 hex; range
  strings validated with `semver.validRange` — the `semver` dependency arrives with
  spec-02).
- Schema-file generation: `packages/core/scripts/emit-json-schemas.ts` (or a package
  script) writing to `packages/core/schemas/*.v1.json`; a unit test regenerates and
  diffs (the blocks repo's dist-drift-guard pattern).
- The reference layout change in `I:\ion-shift\blocks` (versioned `dist/<version>/`
  paths, `registry/blocks/*.json`) is **executed by spec-05**, not this spec — but this
  spec's doc examples must match what spec-05 emits.
- Documentation: new `docs/concepts/block-registries.md` section or a rewrite pass on
  `docs/concepts/building-blocks.md` §registry — do a stub here, full docs ride spec-05.

## Acceptance criteria

1. `@ion-drive/core` exports the three Zod schemas + parse helpers; malformed inputs
   produce aggregated, human-readable issues (bad digest format, bad semver range,
   missing `latest`, version key ≠ entry's semantic version, yanked without `yankedAt`).
2. JSON Schema files exist in the repo, regenerate deterministically from Zod, and a
   drift test fails when they diverge.
3. A fixture registry (unit-test asset) exercising every field — including relative and
   absolute URLs, deprecated + yanked versions, advisories — round-trips through the
   parsers.
4. `parseRegistryIndex` rejects a legacy-shaped index (no `schemaVersion`) with the exact
   "pre-release unversioned format" message.
5. The spec's examples validate against the published schemas (test does this literally).

## Test plan

Unit tests in `packages/core/src/blocks/registry-types.test.ts`: happy-path parse of the
fixture registry; one test per rejection rule; URL-resolution helper cases (relative,
absolute, traversal like `../../…` is *legal* here — it's URL space, not filesystem);
schema-drift test. No integration tests needed (no I/O in this spec).
