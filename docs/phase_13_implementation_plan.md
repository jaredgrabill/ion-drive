# Phase 13 — Relational Completeness (GraphQL parity + schema engine)

**Status: IN PROGRESS 2026-07-06** · Roadmap items F6 (GraphQL half), F17, F9, admin m2m polish
(`docs/roadmap.md` Phase 13) + the two explicit deferrals parked here: GraphQL subscriptions
(Phase 12 Tier 4) and GraphQL mutations for block actions (Phase 14 Tier 2).

Phase 10 made relationships real (link fields, `expand=`, junction recording); Phase 12 pushed
events to the edge. Phase 13 finishes the relational story: **GraphQL becomes a first-class
relational surface** (nested traversal, subscriptions, action mutations), **many-to-many links
become writable** (they could only be created via SQL until now — nothing on any surface wrote
junction rows), and **relationships become deletable** (the last one-way door in the schema
engine).

A tier is the unit of "done": each lands with unit tests and is independently shippable.

---

## Tier 1 — DataService relational completeness (the shared machinery)

Everything GraphQL needs lands in `DataService` first, so REST/MCP/SDK inherit it (surface
parity by construction).

**1A — Reverse traversal in `expand`.** Today `applyExpansions` only hydrates the FK-holding
side (single parent) and m2m. The "one" side of a one_to_many (parent → children list) and the
non-FK side of a one_to_one are silently ignored. New: a reverse expansion, batched
(`WHERE <fk> IN (parent ids)`), attaching `Record[]` (or `Record | null` for one_to_one).

**Reverse key naming:** the stored `rel.name` names the *belongs-to* direction (e.g. contacts'
`company`); reusing it from the parent side would read backwards (`Company.company = [Contact]`)
and collides when two objects link the same target under the same rel name (crm does exactly
this). Reverse expansions are addressed as **`<manySideObject>_by_<relName>`** (e.g.
`expand=contacts_by_company` on `companies`) — unambiguous (source object + rel name is the
uniqueness scope) and self-describing. Same key on every surface: REST `expand=`, GraphQL field,
MCP `expand`.

**1B — m2m link writes.** `DataService.addLinks(object, id, relName, targetIds)` /
`removeLinks(...)`: validate the rel is m2m and lives on the object, verify the record exists,
insert junction rows (`ON CONFLICT DO NOTHING` — idempotent) / delete them, inside a
transaction that also publishes **`data.<object>.link` / `data.<object>.unlink`** events
(payload `{ object, id, op, relationship, targetObject, targetIds, actor }`) — same outbox
pattern as CRUD. Friendly 400s for unknown rel / non-m2m / missing record / unknown target ids
(FK violation mapped).

**1C — REST + OpenAPI.** `POST /api/v1/data/:object/:id/links/:rel` body `{ ids: [...] }` →
`{ data: { added } }`; `DELETE` (same body) → `{ data: { removed } }`. RBAC: `update` on the
object (writing an association mutates the record's connections). Reflected in OpenAPI.

**1D — `hydrateRelation` goes public.** `applyExpansions` gets a public single-relation wrapper
so the GraphQL loader (Tier 2) batches through the exact same code path.

## Tier 2 — GraphQL relationship traversal (F6) + link mutations

- Object types gain **relation fields**: `rel.name` on the FK side (single, nullable target),
  `rel.name` on either m2m side (non-null list), and `<obj>_by_<rel>` reverse fields (list for
  one_to_many, single for one_to_one) — exactly the expand keys, resolved lazily via type
  thunks (cycles are fine). A relation field is skipped if a column field already owns the name.
- **Batching:** a per-request `RelationLoader` (tiny DataLoader, microtask-flushed, no dep) in
  the yoga context queues parent rows per `(object, relKey)` and calls the shared
  `DataService.hydrateRelation` once per tick — nested lists don't N+1.
- **Depth cap:** a custom validation rule rejects queries nested past `MAX_QUERY_DEPTH` (12
  selection levels; introspection fields exempt) with a clear error. Reflection makes the type
  graph cyclic, so an explicit cap replaces the previous "flat types" implicit one.
- Mutations `link_<object>_<rel>(id, ids)` / `unlink_<object>_<rel>(id, ids)` → count, backed by
  Tier 1B (m2m rels only).

## Tier 3 — GraphQL subscriptions + action mutations (the parked deferrals)

- **`Subscription.events(topics: [String!]): IonEvent!`** — bridges `RealtimeBridge` into an
  async iterator (push queue, cleanup on return). Same semantics as the SSE stream: topic
  patterns (default `data.#`), best-effort from connect, **per-event RBAC** (`data.<object>.*`
  → `read` on the object, else `read` on `events`; verdicts cached per subscription;
  anonymous under enforcement sees an auth error at subscribe time). Served by yoga's built-in
  GraphQL-over-SSE. Registered only when the outbox bus is live (same gate as the stream route).
  `IonEvent = { id, topic, occurredAt, payload(JSON) }`.
- **Action mutations:** every installed block action appears as
  `Mutation.<block>_<action>(input: JSON): JSON`, running through the same `ActionExecutor`
  (declared+registered resolution, Zod validation, RBAC from the manifest/default, spans +
  metrics + timeout). Input stays a JSON scalar — the Zod schema is the validator; deriving
  typed GraphQL inputs from Zod is a fidelity trap (unions, refinements) for no real gain.
- **Cache key grows:** the schema provider still rebuilds on registry-version change, and
  re-checks the installed-action fingerprint at most every 15s (block installs usually bump the
  registry version anyway; the fingerprint catches logic-only installs). Execution correctness
  never depends on the cache — resolution re-checks installed state per call.

## Tier 4 — `SchemaManager.removeRelationship` (F17) + snapshot prune

- **Engine:** `removeRelationship(sourceObject, relName, { dryRun, force })` — relationship
  names are scoped per source object, so the address is the pair. ChangeSet type
  `remove_relationship` through the standard validate → DDL → metadata → migration → registry
  pipeline. Validation: block-managed relationships error (`BLOCK_MANAGED_FIELD`-style, named
  block, `force` downgrades to warning); data-loss warnings name exactly what drops (the FK
  column and its values, or the junction table and its N link rows — counted live).
- **DDL:** FK-backed → drop the FK column (constraint goes with it) + its `_ion_fields` row;
  m2m → drop the junction table. Then delete the `_ion_relationships` row, record the
  migration, re-hydrate both endpoint objects.
- **REST:** `DELETE /api/v1/schema/objects/:name/relationships/:relName?dryRun&force` —
  preview-first like `modifyField`. **MCP:** `remove_relationship` tool.
- **Snapshot:** `push --prune` now removes relationships missing from the snapshot (it warned
  and skipped before); relationship diffs report removals as executable changes.

## Tier 5 — MCP + client SDK parity for links

- MCP tools `link_records` / `unlink_records` (`object, id, relationship, target_ids`).
- Client SDK: `from(obj).link(id, rel, ids)` / `.unlink(id, rel, ids)`; docs in querying.md.

## Tier 6 — Admin (relationship delete + m2m editing)

- **Relationships tab:** delete action — preview dialog (warnings incl. live link counts),
  type-to-confirm on data loss, "Override protection" for block-managed (mirrors
  FieldEditorSheet's force flow).
- **m2m in the grid:** m2m relationships render as a virtual chip-list column (expand-fed,
  read-only chips + count overflow); **RecordSheet** gains an m2m section — chips with remove ×,
  add via the existing `RecordPicker`, wired to link/unlink.

## Tier 7 — F9 decision + docs + close-out

- **Migration rollback: DROP.** `sql_down` stays recorded as *advisory documentation* — an
  automated rollback API would need the full data-loss-guard pipeline to be trustworthy, and
  the platform already has better recovery paths (snapshot pull/push is declarative and
  validated; PITR/backups cover disasters). Documented in ADR-020 + `schema-manager.ts` JSDoc +
  roadmap.
- Docs: `api/graphql.md` (traversal, depth cap, subscriptions, action mutations, link
  mutations), `api/realtime.md` (GraphQL subscription section), `api/querying.md` +
  `api/rest.md` (reverse expand keys, links endpoints), `concepts/data-objects.md`
  (removeRelationship), `docs/api/actions.md` (GraphQL mutation surface).
- ADR-020 (all decisions above), integration scenarios (traversal + depth cap, subscription
  receives a create, link/unlink round-trip incl. events, removeRelationship both shapes,
  action mutation), live smoke, CLAUDE.md/roadmap/memory updates.

## Out of scope

File storage (Phase 15), multi-tenancy (16), field/row RBAC (17), GraphQL cursor/Relay
connections (page/pageSize model is deliberate), nested writes (create-with-children),
`ion-drive diff` (Phase 14 follow-up).
