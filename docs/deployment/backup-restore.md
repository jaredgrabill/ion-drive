# Backup & Restore

Ion Drive keeps **all of its state in one PostgreSQL database**, which makes
backup unusually simple — but there are two environment values you must
preserve alongside the database, or parts of a restore will be unrecoverable.

> **There is no built-in backup command.** Ion Drive deliberately leans on
> standard Postgres tooling (`pg_dump`, WAL archiving, your provider's
> snapshots) rather than reinventing it.

## What to back up

**1. The PostgreSQL database.** Everything lives there:

| Layer | Tables |
|:---|:---|
| Schema metadata (your object definitions) | `_ion_objects`, `_ion_fields`, `_ion_relationships`, `_ion_migrations` |
| Your actual data | one table per data object |
| Auth (users, sessions, accounts) | Better Auth's tables |
| RBAC, API keys, secrets, config | `_ion_roles`, `_ion_api_keys`, `_ion_secrets`, `_ion_config` |
| Tasks + run history | `_ion_tasks`, `_ion_task_runs` |
| Installed blocks ledger | `_ion_blocks` |
| Event outbox + delivery ledger | `_ion_events`, `_ion_event_deliveries` |

**2. `ION_ENCRYPTION_KEY`.** Values in `_ion_secrets` are encrypted at rest
with AES-256-GCM using a key derived from this variable (a 64-char hex string
is used directly as the 32-byte key; any other string is stretched via scrypt).
The key is **not** stored in the database. Without the exact same
`ION_ENCRYPTION_KEY`, a restored `_ion_secrets` table is ciphertext you can
never decrypt — there is no recovery path.

**3. `ION_AUTH_SECRET`.** Signs auth sessions/tokens (falls back to the
encryption key when unset). Losing it is survivable — users just re-log-in —
but restoring with the same value keeps existing sessions valid.

Store both values in your secret manager with the same care (and the same
retention) as the database backups themselves.

## Taking a backup

Against any Postgres, the custom-format dump is the workhorse:

```bash
pg_dump --format=custom --file=ion_drive.dump \
  "postgresql://ion:ion@localhost:5432/ion_drive"
```

With the dev Docker Compose setup (`docker/docker-compose.yml`), exec into the
container:

```bash
docker exec ion-drive-postgres \
  pg_dump -U ion --format=custom ion_drive > ion_drive.dump
```

Run backups on a schedule (cron, your provider's automation) and test restores
periodically — an untested backup is a hope, not a backup.

### Point-in-time recovery

`pg_dump` gives you the state at one moment. For continuous protection, use
Postgres **WAL archiving / PITR** — every managed provider (RDS, Cloud SQL,
Neon, …) offers it as a checkbox, and self-hosted setups can use
[pgBackRest](https://pgbackrest.org/) or [barman](https://pgbarman.org/). Ion
Drive needs nothing special: it is a normal Postgres client.

## Restoring

Order matters, but only a little:

1. **Create an empty database** and restore the dump into it:

   ```bash
   createdb ion_drive_restored
   pg_restore --dbname=ion_drive_restored --no-owner ion_drive.dump
   ```

   Docker Compose variant:

   ```bash
   docker exec -i ion-drive-postgres \
     pg_restore -U ion --dbname=ion_drive --no-owner --clean --if-exists < ion_drive.dump
   ```

2. **Set the same env values** the backed-up server ran with — at minimum
   `ION_DATABASE_URL` (pointing at the restored DB) and the **original**
   `ION_ENCRYPTION_KEY` and `ION_AUTH_SECRET`.

3. **Start the server.** No migration or import step is needed: at boot the
   schema engine hydrates its in-memory registry from the `_ion_*` metadata
   tables, and all bootstrap routines (platform tables, event tables, auth
   migrations, default roles) are idempotent create-if-absent — they leave
   restored data alone. Your objects are live on REST/GraphQL/MCP immediately.

If the restored `_ion_secrets` values fail to decrypt ("Invalid ciphertext"
or auth-tag errors), the encryption key doesn't match the one that wrote them
— fix the key; re-encrypting is not possible without it.

## Schema snapshots are not backups

`ion-drive schema pull` writes the server's declarative schema snapshot to
`ion/schema.json` — great for **versioning your schema in git** and promoting
it between environments with `schema diff` / `schema push`. But it contains
**schema only**: no records, no users, no secrets, no tasks' run history. Use
it alongside database backups, never instead of them.
