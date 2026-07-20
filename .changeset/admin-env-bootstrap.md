---
'@ion-drive/core': minor
---

Env-var admin bootstrap (issue #26). Set `ION_ADMIN_EMAIL` +
`ION_ADMIN_PASSWORD` (or `ION_ADMIN_PASSWORD_FILE`, whose contents are read
and trimmed — for secret mounts) and a fresh database gets its admin account
created **at boot**, through the normal Better Auth signup path (same hashing,
same password policy — a too-weak password fails the boot with a clear error;
the value is never logged), with the admin role granted exactly like
first-signup does today. The bootstrap runs before the server listens, so no
external request can race the zero-users check.

While the variables are set, `ION_DISABLE_SIGNUP` **defaults to `true`**: the
server comes up locked with a working admin in one step (an explicit
`ION_DISABLE_SIGNUP=false` keeps signup open). On a database that already has
credentialed users the variables are ignored with a single info line, so they
are safe to leave set permanently. Without the variables, first-signup-wins is
unchanged. Partial configuration (email without a password source, both
password sources, unreadable/empty password file) refuses to boot with a
message naming the variable.
