# Phase 10: Schema Designer Maturity

Implements [ADR-017](research/architecture-decisions.md#adr-017-backend-platform-positioning-metadata-layer-retained-under-three-governance-rules-phase-10).

Ion Drive is an **application backend platform**: apps read/write through the SDK/REST/GraphQL/MCP;
the admin console exists for visibility, schema/block management, and metrics. Phase 10 finishes the
half-built field metadata layer under three governance rules:

1. **Anything Postgres can enforce lives in Postgres** — metadata mirrors DB truth, never substitutes for it.
2. **Metadata-only facts are presentation-only** — display name, description, order, control hint, enum colors.
3. **Drift is expected and made boring** — schema export/sync + a reconcile doctor, not a "don't touch the DB" policy.

Deliberately out of scope (CMS-market distractions): interface/display configurators, layout metadata,
content-editor workflows (drafts, locales, publishing).

---

## Tier 0 — Engine: field modification

The change-type enum already declares `modify_field`/`rename_field` and `ChangeValidator` has a
`modify_field` case; `DdlExecutor` already has `renameColumn`. This tier implements the missing middle.

### 0A: `SchemaManager.modifyField` / `renameField`

- `modifyField(objectName, fieldName, updates)` builds a ChangeSet, validates, executes DDL, updates
  `_ion_fields`, records the migration, bumps the registry — same pipeline as `addField`.
- Supported updates, each with its own safety analysis in `ChangeValidator`:
  - **Type change** via an explicit compatible-type matrix (e.g. `short_text→text` safe;
    `text→short_text` warns + checks `max(length)`; `integer→big_integer` safe; `integer→decimal` safe;
    incompatible pairs are hard errors). Executes `ALTER COLUMN ... TYPE ... USING` with the cast.
  - **`isIndexed`** toggle — always safe (CREATE/DROP INDEX).
  - **`isUnique`** toggle on — pre-check for duplicates (`GROUP BY ... HAVING count(*) > 1`); report
    offending values in the preview error if found.
  - **`isRequired`** toggle on — pre-check for NULLs; if present, require a **backfill default**
    (UPDATE nulls → default, then `SET NOT NULL`). Toggle off is always safe.
  - **`defaultValue`** set/change/clear (reuses the Phase 6 `renderDefaultExpression` quoting fix).
  - **`constraints`** — see Tier 1.
- `renameField` — `RENAME COLUMN` + metadata update; warn that API field names change (REST filter
  keys, GraphQL fields, MCP tool args).
- **Preview-first API contract:** `PATCH /api/v1/schema/objects/:name/fields/:fieldName` accepts
  `?dryRun=true` returning the `ChangePreview` (SQL, warnings, errors); the admin UI always previews
  before applying. Route is RBAC-guarded like the existing schema routes.

### 0B: Metadata additions

- `FieldDefinition` gains `description?: string` and `uiOptions?: Record<string, unknown>`
  (presentation-only bag: control hint, enum choice colors, rating scale, currency code, textarea rows).
- `_ion_fields` gains `description` + `ui_options` columns (system-table migration on boot, following
  the existing platform-tables pattern). Round-trip through `MetadataStore`, schema routes, OpenAPI
  object metadata, and MCP schema introspection.

### 0C: Provenance & protected schema (`managedBy`)

- `DataObjectDefinition` and `FieldDefinition` gain `managedBy?: 'user' | 'block:<name>' | 'system'`
  (default `user`; distinct from `isSystem` = platform-internal). New `managed_by` columns on
  `_ion_objects`/`_ion_fields`; `BlockInstaller` stamps `block:<name>` on everything it creates
  (skipped/pre-existing items keep their owner).
- **Enforcement in `SchemaManager`** (so all surfaces inherit it): structural mutations against a
  block-owned field — remove, rename, type change, constraint loosening — fail with a typed error
  naming the owning block; `?force=true` (admin permission) overrides, mirroring install-force.
  Presentation-only updates (displayName, description, `uiOptions`, `isIndexed`) are always allowed.
- **Objects are not locked**: adding user fields to a block-owned object is the customization story;
  object delete/rename continues through the Phase 6 uninstall guards.
- Admin: "managed by <block>" badge on fields/objects; protected actions disabled with a tooltip and
  a force path behind type-to-confirm.
- Drift doctor (4B) uses provenance: manual-SQL drift on block-owned tables reports at higher
  severity ("may break the <block> block"). Uninstall keeps working from the ledger snapshot, but
  provenance lets it also warn when block fields were force-modified since install.

## Tier 1 — Constraints: DB-enforced, everywhere-reflected

### 1A: CHECK constraint generation (rule 1)

- `DdlExecutor` renders `FieldConstraints` as named `CHECK` constraints
  (`ion_ck_<table>_<column>_<kind>`): `min`/`max` → value bounds (numbers) or `char_length()` bounds
  (text); `pattern` → `~` regex; `enumValues` → `IN (...)` (also for `multi_enum` via `<@`).
- `addField` applies them at creation; `modifyField` adds/drops/replaces them. Tightening a constraint
  pre-validates existing rows and reports violations in the preview.
- Existing pre-Phase-10 enum fields: validate-then-add-constraint path surfaced through the same preview.

### 1B: Surface reflection

- **DataService**: friendly pre-validation on create/update (typed `DataServiceError` with the
  constraint `message`) so API callers get a 400 with field detail instead of a raw PG check violation;
  PG remains the backstop for any path that bypasses the service.
- **OpenAPI**: `minimum`/`maximum`/`minLength`/`maxLength`/`pattern`/`enum` on generated schemas.
- **GraphQL**: enum fields become real GraphQL enum types where values are identifier-safe (fallback
  String otherwise); descriptions flow into the SDL.
- **MCP**: `query_data`/create/update tool schemas carry the same constraints + descriptions.
- **Admin**: RecordSheet zod schemas and grid cell editors derive min/max/length/pattern/enum from
  field definitions (today only `isRequired` is honored).

## Tier 2 — Admin: field designer overhaul

### 2A: Type picker with full disclosure

- `/api/v1/schema/column-types` returns the full `COLUMN_TYPES` records (name, label, category, pg).
- Picker becomes a grouped, searchable gallery (Text / Number / Date & Time / Boolean / Structured /
  Select / Special / **Link to record**) showing per type: friendly label, the exact PG type, and the
  storage limit in plain words ("Short Text — VARCHAR(255), up to 255 characters").

### 2B: Field editor sheet (replaces the thin Add Field dialog)

- One sheet for add **and** edit: identifier + display name (decoupled), description, type picker,
  type-aware default-value input (uses the `grid-cell-editor` control family — date picker, toggle,
  rating stars, color swatch…), constraint inputs appropriate to the type (min/max, length, pattern,
  custom message), enum choices editor (add/remove/reorder values; color per choice in `uiOptions`),
  required/unique/indexed toggles.
- Editing shows the **change preview** (SQL + warnings from 0A) with an explicit confirm; destructive
  or lossy warnings styled like the existing type-to-confirm patterns.
- Schema tab: drag-to-reorder rows persisting `sortOrder` (was deferred from Phase 8); description
  shown under the field name; PG type shown next to the friendly type badge.

## Tier 3 — Relation fields (the Airtable moment)

### 3A: "Link to record" pseudo-type

- In the designer, "Link to record" appears as a field type. User picks the target object and
  single vs. multiple. On save the platform creates, in one managed operation:
  - **single** → FK column `<name>_id` + a `many_to_one` relationship (real FK constraint);
  - **multiple** → a `many_to_many` relationship (junction table, as `addRelationship` already builds).
- Not a new column type in `COLUMN_TYPES` — a designer-level composite over the existing
  field + relationship primitives, recorded so the schema tab and Relationships tab present one truth.

### 3B: Linked-record editing & display

- Grid: FK cells render the target record's display field as a chip (target's first text field, or a
  `uiOptions.displayField` override) with click-to-peek (side panel, Supabase-style); editing opens a
  record picker (search via the existing `q=` querying). Multiple links render chip lists.
- RecordSheet: same picker control; expand uses the existing `expand=` query support.

## Tier 4 — Sync & drift (rule 3)

### 4A: Schema snapshot export/import

- `GET /api/v1/schema/snapshot` — full declarative snapshot (objects, fields incl. constraints +
  uiOptions, relationships) with a schema-format version; `POST /api/v1/schema/snapshot?dryRun` —
  diff current state vs snapshot and return the ChangeSet preview; apply executes it through the
  normal validated pipeline.
- CLI: `ion-drive schema pull` (write snapshot to `ion/schema.json`), `schema diff`, `schema push`
  (preview + confirm) — PocketBase-style Git-friendly environment promotion.

### 4B: Drift doctor

- `GET /api/v1/schema/doctor` — diff `information_schema` against `_ion_objects`/`_ion_fields`:
  unmanaged tables, unmanaged columns on managed tables, type mismatches, missing columns.
- Report, never auto-fix. Each finding offers an **adopt** action (import the column/table into
  metadata with inferred friendly type) or **ignore** (persisted allowlist). Admin Settings gets a
  "Schema health" card; CLI gets `ion-drive schema doctor`.

---

## Verification plan

- Unit: type-compat matrix, constraint DDL rendering, doctor diffing, snapshot round-trip,
  designer form logic, linked-record picker.
- Live smoke against Postgres: modify-field lifecycle (widen type, tighten with violations → preview
  error, required-with-backfill), CHECK enforcement via raw SQL bypass, relation field end-to-end
  (create link field → FK exists → grid chip → picker edit), snapshot pull→push onto a fresh DB,
  doctor detecting a manually added column and adopting it.
- Browser-verify the designer + linked-record UX like Phase 8.

## Sequencing

Tiers are ordered by dependency: 0 → 1 → 2 → 3 → 4, but 4 only depends on 0 and can run parallel
with 2–3. Each tier is independently shippable.
