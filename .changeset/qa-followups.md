---
'@ion-drive/core': patch
---

QA follow-ups from the Gravity Well dogfood sprint (issue #23):

- GraphQL CRUD resolvers now surface `DataServiceError`s as typed GraphQL
  errors (`extensions.code` + the service's message and `field`) instead of a
  masked INTERNAL_SERVER_ERROR — e.g. upsert's `INVALID_CONFLICT_TARGET` and
  translated 409 `unique_violation`s.
- Re-applying a `uniqueTogether` group whose physical `ion_uq_*` constraint
  exists but was lost from metadata (drift) now returns a 409
  `already_exists` naming the constraint, instead of a raw Postgres 42P07 500.
- `$inc`/`$dec` aimed at system columns (`id`, `created_*`, `updated_*`) or
  unknown columns is now a 400 `INVALID_ATOMIC_OP` instead of a silent no-op.
- `PATCH /api/v1/roles/:id` with a permissions-only body no longer wipes the
  role's description (partial-update semantics; explicit `null` still clears).
- The intentionally-corrupt sigstore fixtures are marked `-text` in
  `.gitattributes` so EOL normalization can never invalidate their byte-exact
  SHA256 assertions.
- Docs: `-g`/`--globoff` note for curl's bracket globbing (querying + REST),
  the node-SDK no-cookie-jar caveat, and the row-policy `contains` planting
  consequence (plus a code comment on why the reassignment guard excludes
  `contains`).
