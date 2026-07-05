# Deploying with Docker

Ion Drive ships a multi-stage production `Dockerfile` and Compose files for both
the app's PostgreSQL dependency and an optional observability stack.

## Development: just PostgreSQL

In development you typically run the app locally (`pnpm dev`) and only need
Postgres in a container:

```bash
docker compose -f docker/docker-compose.yml up -d
# Postgres on localhost:5432 (user: ion, password: ion, db: ion_drive)
```

The Compose file also contains a commented-out `ion-drive` service — uncomment
it to run the whole app in Docker instead of locally.

## Production image

The `docker/Dockerfile` is a two-stage build (build → slim runtime), runs as a
non-root user, and has a `/health` healthcheck:

```bash
# Build from the repo root
docker build -f docker/Dockerfile -t ion-drive/core:latest .

# Run it
docker run -d --name ion-drive \
  -p 3000:3000 \
  -e ION_DATABASE_URL='postgresql://ion:ion@your-db-host:5432/ion_drive' \
  -e ION_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -e ION_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e ION_REQUIRE_AUTH=true \
  ion-drive/core:latest
```

The image serves the API on port 3000 and the built admin console from
`packages/admin/dist`.

## Configuration

All configuration is via environment variables (validated at boot). The most
important ones:

| Variable | Default | Purpose |
|:---|:---|:---|
| `ION_PORT` | `3000` | HTTP port. |
| `ION_DATABASE_URL` | `postgresql://ion:ion@localhost:5432/ion_drive` | System DB connection. |
| `ION_ENCRYPTION_KEY` | *(dev key)* | 32-byte hex; **set this in production** (encrypts secrets). |
| `ION_AUTH_SECRET` | falls back to encryption key | Signs auth sessions/tokens. |
| `ION_REQUIRE_AUTH` | `false` | Enforce RBAC on data/schema/admin endpoints. |
| `ION_PUBLIC_URL` | — | Public base URL (used as the auth base URL). |
| `ION_CORS_ORIGINS` | `true` | Allowed CORS origins. |
| `ION_LOG_LEVEL` | `info` | `fatal`…`trace`. |
| `ION_METRICS_ENABLED` | `true` | Prometheus endpoint at `/metrics`. |
| `ION_OTEL_ENABLED` | `false` | Export traces/logs (+ optionally metrics) over OTLP/HTTP. |
| `ION_OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP collector. |
| `ION_TASKS_ENABLED` | `true` | Scheduled task engine. |
| `ION_BLOCKS_ENABLED` | `true` | Building-block install surface. |

> **Production checklist:** always set `ION_ENCRYPTION_KEY` and `ION_AUTH_SECRET`
> to strong random values, enable `ION_REQUIRE_AUTH`, and put the server behind
> TLS. The default dev encryption key is insecure by design and logs a warning.

## Observability stack

An optional overlay brings up Grafana, Loki, Prometheus, and Tempo:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.observability.yml up -d
```

Then set `ION_OTEL_ENABLED=true` (and point `ION_OTEL_EXPORTER_OTLP_ENDPOINT` at
the collector/Tempo) to ship traces and logs. Metrics are scraped from the
in-process `/metrics` endpoint by Prometheus. See
[ADR-012](../research/architecture-decisions.md) for the telemetry design.

## Health & readiness

- `GET /health` — liveness/readiness (also the container `HEALTHCHECK`). Returns
  status, version, schema version, and object count.
- `GET /metrics` — Prometheus text exposition (when `ION_METRICS_ENABLED`).

## Notes

- **Database-per-tenant** is the default multi-tenancy model; provision a
  database per tenant and connect with the appropriate `ION_DATABASE_URL`.
- Run database backups against Postgres as usual — all state (schema metadata,
  data, secrets, tasks, blocks ledger) lives there.
