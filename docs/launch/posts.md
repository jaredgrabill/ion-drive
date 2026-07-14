# Launch post drafts — for owner review before posting

Lane 4 §2 of [the launch plan](../launch_plan.md). Every post keys to the wedge
and carries the golden path inline. Stagger over days; the owner replies
personally to every comment. Do not post until Lane 1 is done (packages on npm,
registry + site live) and the Lane 3 copy PR is merged.

---

## 1. Show HN

> **Title:** Show HN: Ion Drive – self-hostable, MCP-native backend an AI agent
> stands up in minutes
>
> I built Ion Drive because every time I pointed a coding agent at a new
> project, the first hour disappeared into backend boilerplate: define a
> schema, wire up CRUD, write the API layer, repeat.
>
> Ion Drive is a self-hosted backend (TypeScript/Fastify/Postgres, Apache-2.0)
> where tables are defined at runtime — by you in an admin console, or by your
> agent over MCP. The moment an object exists it's a REST endpoint, a GraphQL
> type, an MCP tool, and a row in an admin grid. No migrations, no codegen, no
> restart.
>
>     npx @ion-drive/cli init my-app && cd my-app
>     docker compose up -d && npm install
>     npm run dev              # REST + GraphQL + MCP + admin console at :3000
>     npx ion-drive add crm    # domain blocks land as editable code in blocks/
>
> Then mint an API key in /admin and point any MCP client at /api/v1/mcp. My
> test agent goes from empty database to "create these three tables, seed
> them, show me the high-priority rows" in under a minute of tool calls.
>
> Two design choices I'd love feedback on:
>
> 1. *Blocks are vendored code, not packages.* `ion-drive add invoicing` drops
>    the Stripe integration into blocks/invoicing/ in your repo — shadcn-style.
>    You edit it; updates arrive as diffs you review, never overwrites.
>    Artifacts are digest-verified and sigstore-attested.
> 2. *Auth is on by default.* First user to sign up becomes admin, signup can
>    lock after bootstrap, and a production boot with auth off refuses to
>    start unless you explicitly acknowledge an open deployment.
>
> Site: https://iondrive.dev · Source: https://github.com/jaredgrabill/ion-drive
> (Apache-2.0). It's early — I want the first ten real users' friction reports
> more than stars.

## 2. r/selfhosted

> **Title:** Ion Drive — a self-hosted backend where your AI agent (or you)
> defines the schema at runtime; REST/GraphQL/MCP come free [Apache-2.0]
>
> Fellow self-hosters — I just published the first release of Ion Drive, an
> open-source application backend you run on your own box (Node 22 + Postgres
> 17, or the Docker image at `ghcr.io/jaredgrabill/ion-drive`).
>
> The pitch in one line: **the self-hostable, MCP-native backend an AI agent
> stands up in minutes — with domain blocks you own as editable code.**
>
> What that means concretely:
>
> - Define tables at runtime (admin console or API) — every table instantly
>   gets REST + GraphQL + MCP + OpenAPI, backed by one query engine.
> - Domain "blocks" (CRM, invoicing w/ Stripe, audit log…) install like
>   shadcn/ui: schema applies server-side, logic lands as code in your repo.
> - Self-hosting is the *primary* target, not the community tier: auth/RBAC on
>   by default, signup lockout, rate limiting, signed webhooks, OpenTelemetry
>   + a Grafana/Loki/Tempo compose overlay, backup/restore + security docs.
>
>     npx @ion-drive/cli init my-app && cd my-app
>     docker compose up -d && npm install && npm run dev
>
> Docs: https://iondrive.dev · Source: https://github.com/jaredgrabill/ion-drive
> Would genuinely love first-run reports — friction fixes jump the queue.

## 3. MCP community (r/LocalLLaMA, MCP Discord, or r/mcp)

> **Title:** I built a backend where the MCP server *is* the product — agents
> define tables, CRUD data, and call domain actions over one endpoint
>
> Most MCP servers wrap an existing SaaS. Ion Drive inverts it: it's a
> self-hosted backend (Postgres under the hood) designed MCP-first, so an
> agent can *build* the backend, not just query it.
>
> One Streamable HTTP endpoint (`/api/v1/mcp`) exposes:
>
> - schema tools: `create_object`, `add_field`, `modify_field` (preview-first —
>   the agent sees the exact SQL + warnings before applying), relationships
> - data tools: `query_data` (full query language: search, operators, sort,
>   pagination, relation expansion), `create/update/delete_record`, m2m links
> - every installed block's actions as `<block>_<action>` tools — install the
>   invoicing block and your agent can create Stripe payment links
>
> Everything the agent builds is simultaneously REST + GraphQL + an admin UI,
> so humans see the same data in an editable grid. Auth is API-key based and
> on by default; the scaffold ships an AGENTS.md so agents know the ropes.
>
>     npx @ion-drive/cli init my-app && cd my-app
>     docker compose up -d && npm install && npm run dev
>     # /admin → API Keys → role-bound key → claude mcp add …
>
> Apache-2.0, TypeScript. https://iondrive.dev ·
> https://github.com/jaredgrabill/ion-drive — feedback and first-run reports
> very welcome.

## 4. X/Bluesky thread

> **1/** Shipped: Ion Drive — the self-hostable, MCP-native backend an AI
> agent stands up in minutes. Apache-2.0, TypeScript, Postgres.
>
> **2/** The loop: `npx @ion-drive/cli init`, `npm run dev`, point your agent
> at /api/v1/mcp. It creates tables, inserts data, queries it back — and every
> object is instantly REST + GraphQL + an admin grid. No migrations, no
> codegen. [demo gif]
>
> **3/** Domain features install like shadcn/ui: `ion-drive add invoicing`
> drops the Stripe integration into your repo as code you own. Updates arrive
> as diffs you review. Digest-verified, sigstore-attested.
>
> **4/** Self-hosted means secure by default here: auth/RBAC on out of the
> box, signup locks after bootstrap, production refuses to boot open, signed
> webhooks, OTel built in.
>
> **5/** It's day one and I want friction reports more than stars. Golden
> path + docs: https://iondrive.dev · repo:
> https://github.com/jaredgrabill/ion-drive

## 5. MCP servers directory listing

Target: the `modelcontextprotocol/servers` community list (README PR) and any
curated "awesome-mcp-servers" lists.

> **Ion Drive** — Self-hostable backend platform whose MCP server exposes
> runtime schema management (create/modify tables with preview-first DDL),
> full CRUD with a rich query language, relationship traversal, and installed
> domain blocks' actions as tools. Everything an agent builds is also
> REST/GraphQL/OpenAPI + an admin console. `http` transport at
> `/api/v1/mcp`; API-key auth. [Site](https://iondrive.dev) ·
> [Repo](https://github.com/jaredgrabill/ion-drive)

---

## Demo asset script (Lane 3 §5 — owner records or approves)

One take, ~35s, in a clean terminal (or asciinema→gif). Font ≥16px, dark theme:

```text
npx @ion-drive/cli init my-app        # wait for the "Ready for launch" panel
cd my-app && docker compose up -d && npm install   # cut/speed-up the install
npm run dev                           # pause on "admin console at /admin"
# browser bleep: localhost:3000/admin → sign up → API Keys → new key (role: admin)
claude mcp add -t http ion-drive http://localhost:3000/api/v1/mcp --header "X-API-Key: iond_…"
# in the agent: "Create a launch_notes object (title, body, priority int).
#                Add three notes, then list the ones with priority ≥ 2."
# browser: /admin → Objects → launch_notes — the three rows are there
```

Embed as `docs/assets/golden-path.gif` in README (below the 4 commands) and on
the site landing. Keep it honest — real timing, no cuts inside the agent step.
