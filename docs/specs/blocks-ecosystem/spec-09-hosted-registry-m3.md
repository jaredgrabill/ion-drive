# Spec 09 — The Hosted Registry Service (M3) — DRAFT

**Status: DRAFT / roadmap-grade.** This spec is intentionally lighter than 01–08: it is
re-specced to full detail after M2 ships, with real usage data. It exists now so every
earlier spec can be checked against it (nothing in M1/M2 may paint M3 into a corner) and
so the end-state is visible to contributors.

**Lands in:** a new repo (service). **Depends on:** specs 05, 08.

## Scope (target state)

The write side of the main registry: publisher accounts, name policy, a publish API with
tokens **and** OIDC trusted publishing, verified-mark issuance, yank/takedown operations,
and download counts — so third parties publish to `@ion`'s directory-adjacent hosted
registry (or their own namespace on our infra) without sending us PRs.

## Non-goals (permanent)

- **The read path never depends on the service.** Publishing *generates static files*
  (registry JSON, artifacts, bundles) pushed to CDN/object storage; `index.json`,
  `blocks/*.json`, and artifacts remain plain HTTPS GETs that work with the service
  down. This is the invariant every design decision defers to (Helm and npm both
  learned it; we start there).
- Ratings/reviews. Paid blocks/marketplace billing (if ever, separate effort).
- Replacing self-hosted registries — they are first-class forever (protocol parity).

## Design directions (to be finalized at re-spec)

### 1. Dogfood: the service is an Ion Drive project

The service is built as an Ion Drive framework project (`ion-drive init`): publishers,
blocks, versions, tokens, and audit events are **data objects**; the publish endpoint is
a **block action**; artifact storage rides the **StorageProvider port** (S3 plugin,
ADR-021); outbound notifications (publish events, advisory alerts) ride the outbox +
webhooks. This is the strongest possible platform proof and will drive real
requirements back into core (expected: rate-limiting knobs per action, object-level
quotas, public/anonymous read RBAC). A `registry-service` block (open-source, in the
blocks repo) is itself the exemplar "app as block" artifact.

### 2. Identity and names

- Accounts: GitHub OAuth only at first (publishers are developers; it gives us a
  verified repo-ownership signal for free).
- Namespaces on the hosted registry: `@ion` reserved; publishers claim namespaces
  (first-come + review for squatting; official name-dispute policy written down —
  npm's policy is the template). Bare-name blocks exist only in `@ion` (curated).
- Reserved list seeded with official block names + obvious infrastructure terms.

### 3. Publishing

- `ion-drive block publish --registry @ion` → `POST /api/v1/registry/publish` with
  either a **publish token** (scoped, revocable, hashed at rest — the platform's
  API-key machinery) or **OIDC trusted publishing**: the publisher registers
  `owner/repo` + workflow once; the GitHub Actions job exchanges its OIDC token
  directly (server verifies issuer/aud/repo/workflow claims exactly as npm does — our
  own release.yml is the consumer-side precedent).
- Server-side pipeline on publish: manifest parse + `parseManifest`, semver/immutability
  enforcement (version must be new), digest computed server-side (authoritative),
  attestation bundle accepted + verified when provided (OIDC publishes can be attested
  end-to-end), malware/secret-scan hooks (extensible), then static-file generation +
  CDN push + directory update.
- **Verified mark issuance** becomes registry-asserted *in addition to* client-computed:
  the registry stores the verification result and serves it in `blocks/<name>.json`
  (clients still recompute when the bundle is present — trust but verify).

### 4. Operations

- Yank/deprecate/advisory: API + admin UI (the service's own Ion Drive admin console,
  dogfooded again) writing the mutable fields; malware takedown per spec-01 §5 with a
  documented SLA + contact (`security@ionshiftlabs.com`), superseding the git-era
  runbook.
- Download counts: CDN log aggregation (never in the request path), surfaced on the
  site + `blocks/*.json` optional field.
- Abuse/quotas: per-publisher artifact-size and rate limits (platform rate-limit
  machinery + per-action RBAC).

### 5. Migration from the git registry

The git repo remains the *source* for official blocks (publish workflow switches its
last step from "commit to repo" to "call the publish API via OIDC" — same reusable
workflow, one step swapped). Registry URLs don't change (`registry.iondrive.dev` moves
from Pages to the service's CDN output). Consumers notice nothing — that's the test.

## Acceptance criteria (draft-level)

1. A third party publishes an attested block version from their GitHub Actions with no
   long-lived secret (OIDC), and `ion-drive add @them/block` verifies + shows
   `✔ verified` with zero maintainer involvement.
2. Read path serves with the service process stopped (static invariant, tested by
   literally stopping it).
3. The service repo is a stock `ion-drive init` project + blocks/plugins — no core
   forks (dogfood invariant).
4. Yank + advisory propagate to `audit`/resolver within one CDN TTL.
5. The name-dispute + takedown policies are published documents.

## Re-spec triggers (when M2 ships)

Finalize: storage/CDN choice, OIDC claim-validation details, token scopes, scan
pipeline, quotas, the `registry-service` block's manifest, admin UI scope, and the
migration cutover runbook. Revisit whether third-party *hosted* namespaces are wanted at
all vs. directory-listed self-hosting only — decide with M2 adoption data.
