---
'@ion-drive/core': minor
---

Bearer-token session verification (issue #24): Better Auth's `bearer` plugin
is now always mounted, so the `token` returned by sign-in endpoints (including
`POST /api/auth/sign-in/anonymous`) verifies via `Authorization: Bearer
<token>` — on `/api/auth/*` and on Ion Drive's own session resolution
(`request.auth`, `GET /api/v1/me`). Bearer-presented sessions resolve the same
identity and roles as cookie sessions, letting a third-party server (e.g. a
Cloudflare Worker) verify a browser-held session it cannot read the HttpOnly
cookie of. API keys are unaffected: `Bearer iond_…` is still routed to the
API-key path by prefix.
