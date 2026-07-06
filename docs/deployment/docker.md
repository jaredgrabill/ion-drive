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
| `ION_RATE_LIMIT_ENABLED` | `true` | Per-IP HTTP rate limiting (429 beyond the limits below). |
| `ION_RATE_LIMIT_MAX` | `300` | Max requests per IP per window (global bucket). |
| `ION_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |
| `ION_RATE_LIMIT_AUTH_MAX` | `20` | Stricter per-IP limit for `/api/auth/*` in the same window. |
| `ION_LOG_LEVEL` | `info` | `fatal`…`trace`. |
| `ION_METRICS_ENABLED` | `true` | Prometheus endpoint at `/metrics`. |
| `ION_OTEL_ENABLED` | `false` | Export traces/logs (+ optionally metrics) over OTLP/HTTP. |
| `ION_OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP collector. |
| `ION_TASKS_ENABLED` | `true` | Scheduled task engine. |
| `ION_BLOCKS_ENABLED` | `true` | Building-block install surface. |

> **Production checklist:** always set `ION_ENCRYPTION_KEY` and `ION_AUTH_SECRET`
> to strong random values, enable `ION_REQUIRE_AUTH`, and put the server behind
> TLS. The default dev encryption key is insecure by design and logs a warning.
> The full hardening pass is in the [Security Checklist](security-checklist.md).

## Observability stack

An optional overlay brings up Grafana, Loki, Prometheus, and Tempo,
pre-configured for Ion Drive (datasources, a Prometheus scrape job, and a
starter dashboard are provisioned from `docker/{grafana,prometheus,loki,tempo}/`):

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.observability.yml up -d
```

What you get:

| Service | URL (host) | Notes |
|:---|:---|:---|
| Grafana | http://localhost:3100 | Login `admin`/`admin`. The **Ion Drive Overview** dashboard (request rate/latency/errors, schema changes, tasks, events) is in the *Ion Drive* folder. |
| Prometheus | http://localhost:9090 | Scrapes the server's `/metrics` every 15s. |
| Tempo | http://localhost:3200 (API), :4317/:4318 (OTLP) | Trace storage; query it through Grafana. |
| Loki | http://localhost:3101 | Log storage; query it through Grafana. |

**Metrics** need no server config — `/metrics` is on by default
(`ION_METRICS_ENABLED=true`) and Prometheus scrapes it at
`host.docker.internal:3000`, i.e. it assumes the server runs on the **host**
(`pnpm dev`). If you run Ion Drive inside Compose instead, change the target in
`docker/prometheus/prometheus.yml` to `ion-drive:3000`.

**Traces** need the server to export OTLP to Tempo:

```bash
ION_OTEL_ENABLED=true
ION_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

**Logs:** the server can export logs over OTLP (`ION_OTEL_LOGS_ENABLED=true`,
default off), but it uses a *single* OTLP endpoint for traces and logs — and
Tempo only accepts traces. To land logs in Loki, put an OTel Collector between
the server and the backends to fan the signals out (Loki's native OTLP ingest
is at `http://localhost:3101/otlp`). The Loki datasource is provisioned and
ready for that setup.

See [ADR-012](../research/architecture-decisions.md) for the telemetry design.

## Health & readiness

- `GET /health` — liveness/readiness (also the container `HEALTHCHECK`). Returns
  status, version, schema version, and object count.
- `GET /metrics` — Prometheus text exposition (when `ION_METRICS_ENABLED`).

## Notes

- Each server instance serves **one database** (`ION_DATABASE_URL`). For tenant
  isolation today, run one instance per tenant with its own database; built-in
  tenant provisioning/routing is on the [roadmap](../roadmap.md) (Phase 16).
- Run database backups against Postgres as usual — all state (schema metadata,
  data, secrets, tasks, blocks ledger) lives there. Recipes and the
  restore procedure are in [Backup & Restore](backup-restore.md).
- Running the image on Kubernetes (probes, replica caveats, metrics scraping)
  is covered in [Deploying on Kubernetes](kubernetes.md).
