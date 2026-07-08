# Spec 04 — Integrity, Provenance, and Trust Tiers

**Lands in:** `jaredgrabill/ion-drive` (`packages/cli` + `packages/core`).
**Depends on:** spec-01 (digest/attestation fields), spec-02 (manifest v1). Runs in
parallel with spec-03; the integration point is the `fetchArtifact → verify → parse`
seam in the registry client.

## Scope

The security layer: sha256 digest verification on every registry install, the sigstore
attestation verification policy and the `official`/`verified`/`community` trust tiers,
the `ion-drive block verify` command, the install-request `source` envelope and the
`_ion_blocks` ledger's provenance columns, and vendoring-path hardening. This is what
makes "verify the integrity of published code (version, timestamp, hash)" real.

## Non-goals

- *Producing* attestations (spec-05's publish workflow).
- Server-side re-fetch-and-verify of artifacts. Deliberately deferred: the server
  receives parsed JSON over the install API, not artifact bytes, and re-serialization
  breaks byte-hashing. Faking it would be security theater; an optional server-side
  fetch-from-registry install mode is a future ADR if demanded.
- Index/registry-file signing (TUF) — see research doc; HTTPS + digest pinning +
  attestations is the M1 posture.
- Non-GitHub CI attestation (GitLab etc.) — sigstore supports other OIDC issuers later
  without protocol change; such publishers are `community` until demanded.

## Design

### 1. Digest: sha256 over the exact artifact bytes

`digest = "sha256:" + hex(sha256(artifactBytes))` where `artifactBytes` is the published
`block.json` file, byte-for-byte. **No canonicalization (no JCS)**: the artifact is
published once and never regenerated (spec-01 immutability), so byte-hashing is
unambiguous — the Helm (`digest` of the tgz) and npm (tarball integrity) precedent — and
avoids an entire class of canonicalization bugs. `block pack` output determinism (sorted
`code[]`, stable key order) remains a nicety, not a security requirement.

### 2. Verification points

**`ion-drive add` (registry refs):** the client computes sha256 over the fetched bytes
*before* JSON.parse, vendoring, or POSTing, and compares with the per-block file's
`digest` for that version.

- Mismatch ⇒ **hard failure, no `--force` override** (a poisoned artifact is never
  "forced"): print expected/actual digests, the artifact URL, "the registry or artifact
  host may be compromised, or the publisher mutated a released version", and abort the
  whole plan (not just that block).
- Match ⇒ proceed; `recordInstalled` stores `{version, digest, source, sourceUrl,
  installedAt}` (field shapes from spec-03).
- Direct-URL refs: no expected digest — compute and record it (`source: "<url>"`),
  and print it once ("pin this by re-adding from a registry, or keep this digest for
  your records"). Local paths: compute over the packed bytes the CLI itself assembles;
  `source: "local"`.
- `size` from the registry entry is checked pre-parse as a cheap sanity/DoS guard
  (mismatch ⇒ same hard failure).

**`ion-drive block verify <ref> [--against-installed] [--json]`** (new command):

- `verify crm@0.2.0` — fetch registry entry + artifact, check digest, then attestation
  policy (§3); print a verdict block: digest OK/FAIL, attestation
  OK/absent/FAIL(reason), computed tier, publishedAt, repo.
- `verify <url|path>` — digest-only (computed + printed; no expectation to compare).
- `--against-installed` — additionally call the server (`GET /api/v1/blocks/<name>`),
  compare the ledger's `artifact_digest` with the registry's for that version; catches
  "the registry mutated after I installed" and "someone installed something else on this
  server".

### 3. Attestation verification policy (the `verified` tier)

Producer side (spec-05): GitHub's `actions/attest-build-provenance` over the artifact,
bundle committed adjacent as `block.json.sigstore.json`, referenced by `attestationUrl`.

Verifier side (this spec), using the **`sigstore` npm package's `verify` API** (no `gh`
CLI dependency — must work on Windows and in CI):

A version is **`verified`** iff ALL of:

1. The bundle parses and verifies against the public sigstore trust root (Fulcio chain,
   Rekor inclusion proof / signed timestamp — the library does this).
2. The bundle's subject digest equals the artifact digest **we computed** (never the
   registry's claim — the whole point).
3. The Fulcio certificate's claims: OIDC issuer is
   `https://token.actions.githubusercontent.com`, and the source repository claim equals
   the per-block file's `repository` field (owner/repo match after normalizing the URL).
4. The registry entry has `repository` set (no repo claim to match ⇒ can't verify).

Tier decision table (computed by the CLI, never self-asserted; third-party registries'
`trust` fields are display hints only):

| Condition | Tier | Badge |
|---|---|---|
| Verified (per above) AND repo is `jaredgrabill/ion-drive-blocks` (constant `OFFICIAL_REPOS` in the CLI, overridable for tests) | `official` | `◆ official` |
| Verified (per above) | `verified` | `✔ verified · github.com/acme/blocks` |
| Anything else (no bundle, verify fails, no repository field, local/URL source) | `community` | `○ community (unattested)` |

**Attestation failure ≠ digest failure:** a bundle that is *absent* ⇒ community tier +
warning line. A bundle that is *present but fails verification* ⇒ loud warning
("attestation present but invalid — treat as unattested; this can indicate tampering")
and community tier; `add` continues (digest still protects integrity; attestation is
provenance). `verify` exits non-zero in this case; `add` does not.

**Cost control:** during `add`, attestation checks run only when a bundle URL is present
(one extra fetch per block); `--no-verify-provenance` skips them (digest check is never
skippable). The sigstore trust root ships with the library (TUF-updated); offline
environments degrade to community tier with a warning, not a failure.

**UX:** plan lines in `add` and rows in `list`/`info` carry the badge. After install,
one summary line per block: `crm 0.2.0 · ◆ official · sha256:ab12…  (attested:
jaredgrabill/ion-drive-blocks@a1b2c3)`. Unattested non-local blocks get exactly one
warning line — no prompts, no nagging. New `--show-code` flag on `add` prints the
vendored file list (path + bytes + sha256 of each) before the confirm prompt; the
confirm default stays yes (the code lands readable in the user's tree — the shadcn
property is the real review surface).

### 4. Install envelope + ledger provenance

**Install API:** `POST /api/v1/blocks/install` body becomes an envelope (the route
already accepts `body?.manifest ?? body`):

```json
{
  "manifest": { …block manifest… },
  "source": {
    "registry": "@ion",
    "url": "https://…/crm/dist/0.2.0/block.json",
    "digest": "sha256:ab12…",
    "attested": true,
    "publisher": "github.com/jaredgrabill/ion-drive-blocks",
    "tier": "official"
  }
}
```

`source` is optional (bare-manifest installs — curl users, tests — keep working) and is
**client-asserted metadata**: the server stores it for audit/ops, it is not a server-side
security control (the RBAC `manage`-on-blocks guard is). Zod-validate the shape; reject
unknown `source` keys.

**Ledger (`_ion_blocks`)** gains nullable columns (boot migration via
`ADD COLUMN IF NOT EXISTS`, the `system-tables.ts` pattern): `artifact_digest` (text),
`source_registry` (text), `source_url` (text), `publisher` (text), `attested` (boolean),
`trust_tier` (text). `BlockStore.begin()` writes them; `GET /api/v1/blocks[/:name]`
returns them; OpenAPI updated; MCP block tools include them; admin Blocks page shows the
badge + digest (small change — note as surface-parity, keep minimal).

This is what makes incident response real: "which servers installed the bad digest?" is
answerable from ledgers, and `verify --against-installed` + `audit` (spec-06) consume it.

### 5. Vendoring-path hardening (defense in depth)

Threat: a malicious artifact writes outside `blocks/<name>/` at `add` time (before any
human reads the code). Today `vendorBlockCode` rejects `..` and leading `/`; core's
`codeFileSchema` rejects the same. Harden both, identically:

- Reject Windows-absolute (`C:\…`, `\\server\…`) and drive-relative (`C:foo`) forms.
- Normalize backslashes to `/` *before* validation, then re-check for `..` segments and
  absolute forms (never validate-then-normalize).
- After joining, `path.resolve` the target and assert it is strictly inside the
  block directory (`resolved.startsWith(blockDir + sep)`) — the belt after the
  suspenders.
- Reject empty segments, `.` segments, and paths > 200 chars; cap `code[].length`
  (e.g. 500 files) and total embedded size (e.g. 5 MB) in `codeFileSchema` to bound
  memory (files are already ≤512 KB each).

Same rules in core (`block-types.ts`) and CLI (`project.ts` vendoring) — two
implementations, one shared test-vector list (documented in both test files).

## Implementation notes (files)

- `packages/cli/src/registry/verify.ts` — new: `computeDigest(bytes)`,
  `verifyDigest(bytes, expected)`, `verifyAttestation(bytes, bundle, repository)`,
  `computeTier(...)`; pure, injectable fetchers. `sigstore` dependency added to the CLI
  (CLI only — core never verifies).
- `packages/cli/src/registry/registry-client.ts` — wire the verify hook into
  `fetchArtifact` consumers (seam defined in spec-03 §3).
- `packages/cli/src/commands/verify.ts` — new command; register in `index.ts`.
- `packages/cli/src/commands/add.ts` — badges, `--show-code`, `--no-verify-provenance`,
  envelope POST, enriched `recordInstalled`.
- `packages/core/src/api/block-routes.ts` — envelope parse; `packages/core/src/blocks/
  block-store.ts` + `config/system-tables.ts` (or wherever `_ion_blocks` DDL lives) —
  columns; `block-engine.ts` — thread `source` through.
- `packages/core/src/blocks/block-types.ts` + `packages/cli/src/project.ts` — path
  hardening.
- Docs: `docs/concepts/building-blocks.md` gains a "Integrity and trust" section
  (digest, tiers, what verified does/doesn't mean — **attestation proves where code was
  built, not that it is safe**); security checklist gains a line.

## Acceptance criteria

1. Tampered artifact (one byte flipped, fixture) ⇒ `add` aborts the whole plan with the
   documented message; no vendored files, no server call; exit ≠ 0. No flag overrides it.
2. Valid artifact + valid bundle + repo match (fixture bundle) ⇒ `verified`; official
   repo constant ⇒ `official`; absent bundle ⇒ `community` + single warning; invalid
   bundle ⇒ community + loud warning, `add` proceeds, `verify` exits non-zero.
3. Bundle subject digest compared against *computed* digest (test: registry lies about
   digest but bundle matches artifact ⇒ still fails on digest step first; registry digest
   matches but bundle subject differs ⇒ attestation fails).
4. `verify --against-installed` catches a ledger/registry digest divergence (fixture).
5. Envelope install records all provenance columns; bare-manifest install still works
   with nulls; `GET /blocks/:name` + OpenAPI + MCP expose them.
6. Path-hardening vectors (shared list: `../x`, `..\\x`, `C:\\x`, `C:x`, `\\\\srv\\x`,
   `a/../../x`, `a\\..\\..`, 201-char path, 501 files) rejected identically by core
   schema and CLI vendoring.
7. Offline (sigstore root unavailable, simulated) ⇒ community + warning, not a crash.

## Test plan

- Unit (CLI): digest vectors; tier decision table exhaustively; attestation with
  pre-generated fixture bundles (generate once with `actions/attest-build-provenance` on
  a scratch artifact in this repo's CI and commit the bundle + bytes as fixtures; also
  hand-corrupt copies for the failure cases). Path vectors.
- Unit (core): envelope parse, ledger writes, path vectors.
- Integration: install-with-envelope scenario in `platform.integration.test.ts`
  asserting ledger columns round-trip through `GET /blocks/:name`.
- Manual smoke: real `verify` against the first attested publish from spec-05 (recorded
  as part of spec-05's exit criteria).
