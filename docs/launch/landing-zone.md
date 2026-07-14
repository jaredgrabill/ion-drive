# Launch landing zone — GitHub settings + first-run discussion

Lane 4 §1 of [the launch plan](../launch_plan.md). The checklist is owner-run
(repo settings); the discussion draft below is ready to paste.

## Repo settings checklist (jaredgrabill/ion-drive)

- [ ] **Enable Discussions** (Settings → General → Features → Discussions).
      Create categories: *Q&A*, *Show and tell*, *First-run reports*.
- [ ] **Pin the "Start here" discussion** (draft below) once created.
- [ ] Issue templates — already in `.github/ISSUE_TEMPLATE/` ✅ (verify they render
      on the New Issue page).
- [ ] `SECURITY.md` ✅ / `CONTRIBUTING.md` ✅ / `CODE_OF_CONDUCT.md` ✅ — all linked
      from README; GitHub should show them in the repo sidebar/community profile
      (Settings → Community Standards should be all green).
- [ ] **Repo description + topics** (Settings → General): description = the wedge
      sentence; topics: `mcp`, `mcp-server`, `backend`, `self-hosted`, `baas`,
      `postgresql`, `fastify`, `typescript`, `ai-agents`, `low-code`.
- [ ] **Social preview image** (Settings → General → Social preview) — optional;
      the site hero screenshot works.
- [ ] Releases: after the `v0.4.0` tag, create a GitHub Release from it with the
      highlights (the release workflow does not auto-create one).

## Pinned discussion draft — "Start here / report your first run"

> **Title:** Start here — and tell us how your first run went
>
> Ion Drive is the self-hostable, MCP-native backend an AI agent stands up in
> minutes — with domain blocks you own as editable code.
>
> **The five-minute path:**
>
> ```bash
> npx @ion-drive/cli init my-app && cd my-app
> docker compose up -d && npm install
> npm run dev              # REST + GraphQL + MCP + admin console at :3000
> npx ion-drive add crm    # blocks land as editable code in blocks/
> ```
>
> Then open `http://localhost:3000/admin`, sign up (first user becomes admin),
> mint a role-bound API key, and point your MCP client at `/api/v1/mcp` —
> [full guide](https://iondrive.dev/docs/getting-started/).
>
> **We want your first-run report.** Whether it took 4 minutes or fell over at
> step 2, reply here (or open an issue) with:
>
> 1. OS + Node version
> 2. What you were trying to build
> 3. Where (if anywhere) you got stuck or confused — friction reports from real
>    runs jump our queue over everything else
> 4. A screenshot of your data in the admin grid if you got there 🎉
>
> Questions welcome below. Security reports: see
> [SECURITY.md](https://github.com/jaredgrabill/ion-drive/blob/main/SECURITY.md)
> — please don't post vulnerabilities publicly.
