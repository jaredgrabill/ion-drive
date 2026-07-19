# Row-level policies

Object-level RBAC answers *"may this role read `players`?"*. Row-level
policies answer *"which `players` rows?"* — the difference between a role that
can read every player and one that can only read **its own** row.

A row policy rides on a normal permission grant, so you configure it exactly
where you configure everything else about a role (the roles API or the admin
Roles editor):

```jsonc
{
  "resource": "players",
  "actions": ["create", "read", "update"],
  "rowPolicy": "own"
}
```

Row policies apply when RBAC enforcement is on (`ION_REQUIRE_AUTH=true`),
across **every** surface — REST, GraphQL (including relation fields), MCP,
aggregates, bulk operations, and the realtime event stream — because they are
enforced once, in the shared data service.

## The policy language

Deliberately tiny and non-Turing. A `rowPolicy` is one of:

| Policy | Meaning |
|:--|:--|
| *(absent)* or `"all"` | No row restriction — exactly the pre-policy behavior. |
| `"own"` | Only rows whose `created_by` equals the acting principal's id. |
| `"none"` | The grant allows the action object-level, but matches no rows. |
| `{ "field": "<f>", "equals": "actor.id" }` | Rows where `<f>` equals the actor's id — generalizes `own` to any user-id column. |
| `{ "field": "<f>", "contains": "actor.id" }` | Rows where `<f>` (a `json` array or `multi_enum` column) contains the actor's id. |

`actor.id` is the only supported binding: the user id for sessions (including
anonymous-plugin guests), the API key id for user-less keys. There are no
comparisons, functions, or nesting — a policy is a lookup, not a program.

## How policies combine

Grants union, and so do their row policies — **the most permissive allowing
grant wins**:

- If *any* grant that allows the action carries no `rowPolicy` (or `"all"`),
  the action is unrestricted. This is also the **bypass**: the built-in
  `admin` role's `{ "resource": "*", "actions": ["manage"] }` grant carries no
  policy, so admins — and API keys bound to the admin role (your service key)
  — always see and touch everything.
- Several restricted policies OR together: a user holding `own` from one role
  and a field match from another sees rows matching either.
- `"none"` contributes nothing (useful for "may hit the endpoint, sees no
  rows yet" states).

Public-role grants may carry row policies too; they union into every
authenticated principal's reads like always (read-only rails still apply).

## What enforcement looks like

- **Reads** — lists, counts, pagination totals, free-text search, and
  **aggregates** all agree: policy conditions join the same WHERE pipeline as
  filters. `GET /:id` on a row outside your policy is a **404**, exactly like
  a missing row — reads never reveal that a hidden row exists.
- **Relations** — `expand=` and GraphQL relation fields apply the **target**
  object's read policy to each hydration: a policy-hidden row hydrates as
  `null` / is absent from lists, like a deleted FK target. Traversing into an
  object your roles have *no* grant on fails closed the same way.
- **Writes** — update/delete (single and bulk) and link writes only touch rows
  your policy matches; anything else 404s. Creates must produce a row you will
  own: `own` works automatically (`created_by` is server-stamped and never
  client-writable), an `equals` field is stamped with your id when you omit it
  and rejected (`403 ROW_POLICY_DENIED`) when you supply someone else's, and a
  `contains` field must already include you.
- **Upserts** — the insert half follows your create policy; the
  conflict-update half counts as an update, applied as the `DO UPDATE`'s
  WHERE. An upsert that conflicts with a foreign row is a `403
  ROW_POLICY_DENIED` — it can never hijack the row.
- **Realtime** — the SSE stream and GraphQL subscriptions additionally check
  each data event's row image against your read policy, so an own-scoped
  reader's feed only shows their own rows' changes.

System code — scheduled tasks, event dispatch, boot — runs outside any
request and is unaffected.

## Worked example: a game backend

The three policies from issue #7 (a multiplayer game with an anti-cheat
posture: no client-writable score surface may exist):

```jsonc
// Role "player" — assign to signed-in users; mirror the players grant onto
// the built-in "anonymous" role if you use guest sign-in.
{
  "name": "player",
  "permissions": [
    // (a) each user reads/updates their own player row only
    { "resource": "players", "actions": ["create", "read", "update"], "rowPolicy": "own" },
    // (c) matches are readable by their participants: the match row carries a
    // json column of participant user ids, written by the server
    { "resource": "matches", "actions": ["read"],
      "rowPolicy": { "field": "participant_ids", "contains": "actor.id" } }
  ]
}
```

```jsonc
// (b) the public leaderboard: world-readable player_stats via the built-in
// "public" role. No user role gets any write action on player_stats —
// so nothing but the service key can write a score.
{ "resource": "player_stats", "actions": ["read"] }
```

The game server holds an API key bound to the **admin** role: it creates
matches (stamping `participant_ids`), writes server-computed stats, and reads
everything — the bypass in action.

> **Relation-scoped policies** ("readable by participants **via an m2m
> relation**") are not in the language yet; the `contains` field match on a
> server-written id column is the supported shape. See ADR-025.

## Guarantees and limits

- **Zero change by default.** No `rowPolicy` on a grant means `"all"`;
  existing deployments behave identically.
- **Fail closed.** A policy naming a field the object doesn't have, or an
  actor-bound policy with no actor, matches nothing rather than everything.
- **Whole rows.** Policies scope which rows you see, not which columns —
  field masking is a planned, separate Phase 17 item. Don't put secrets in
  world-readable rows.
- **Validated at write time.** Malformed policies are rejected (400) on every
  role mutation path, so stored grants are always well-formed.
- Broad platform grants behave as before: a role granted `read` on the `data`
  platform resource (the GraphQL/MCP transport gate) reads objects it has no
  per-object grant for, unrestricted — give scoped roles per-object grants,
  not platform grants.
