# Deploying on Kubernetes

Ion Drive is a single stateless-ish container (all state lives in PostgreSQL),
which makes it straightforward to run on Kubernetes — with one important caveat
about replicas, covered below.

> **No published images yet.** Container images are not published to a registry
> (that is part of the planned release pipeline). Build the image locally from
> the repo and push it to your own registry first:
>
> ```bash
> docker build -f docker/Dockerfile -t registry.example.com/ion-drive:0.1.0 .
> docker push registry.example.com/ion-drive:0.1.0
> ```

The manifests below are **reference manifests** — reviewed against the code,
not certified against a specific cluster. Adjust names, sizes, and ingress
class to your environment.

## Secrets and configuration

All configuration is environment variables (see the
[Docker guide](docker.md#configuration) for the full table). Split them the
usual way: credentials in a `Secret`, everything else in a `ConfigMap`.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ion-drive-secrets
type: Opaque
stringData:
  ION_DATABASE_URL: postgresql://ion:CHANGE_ME@postgres.example.internal:5432/ion_drive
  ION_ENCRYPTION_KEY: "<openssl rand -hex 32>"   # 64-char hex; encrypts _ion_secrets
  ION_AUTH_SECRET: "<openssl rand -hex 32>"      # signs auth sessions/tokens
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ion-drive-config
data:
  NODE_ENV: production
  ION_REQUIRE_AUTH: "true"
  ION_CORS_ORIGINS: "https://app.example.com"
  ION_PUBLIC_URL: "https://ion.example.com"
  # Feature flags (all default on):
  ION_TASKS_ENABLED: "true"
  ION_BLOCKS_ENABLED: "true"
  ION_EVENTS_ENABLED: "true"
  ION_METRICS_ENABLED: "true"
```

> `ION_ENCRYPTION_KEY` and `ION_AUTH_SECRET` are load-bearing: the server
> **refuses to boot** with `NODE_ENV=production` unless at least one is set,
> and losing the encryption key makes stored secrets unrecoverable (see
> [Backup & Restore](backup-restore.md)). Treat both like database credentials.

## Deployment

The image listens on port 3000, runs as a non-root user (uid 1001), and serves
`GET /health` (unauthenticated, exempt from rate limiting) — use it for both
probes.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ion-drive
spec:
  replicas: 1   # see the replica caveat below before raising this
  selector:
    matchLabels: { app: ion-drive }
  template:
    metadata:
      labels: { app: ion-drive }
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: /metrics
    spec:
      containers:
        - name: ion-drive
          image: registry.example.com/ion-drive:0.1.0
          ports:
            - containerPort: 3000
          envFrom:
            - secretRef: { name: ion-drive-secrets }
            - configMapRef: { name: ion-drive-config }
          readinessProbe:
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits: { memory: 512Mi }
```

> **Replica caveat — read before scaling past 1.**
>
> Two background subsystems run **in-process** on every instance:
>
> - **Scheduled tasks** (`tasks/`, croner-based) have **no cross-replica
>   coordination**. Every replica loads all enabled tasks and schedules them
>   independently, so a cron task fires **once per replica**. Croner's
>   `protect` option only prevents a run overlapping *itself within one
>   process* — it does nothing across pods.
> - **Event deliveries** (`messaging/`) *are* replica-safe: each
>   `(event, consumer group)` pair is claimed atomically via the composite
>   primary key on `_ion_event_deliveries`, so a subscription handler runs on
>   exactly one instance per event (at-least-once — handlers should be
>   idempotent on the event id). Subscriptions marked `perInstance`
>   intentionally run on every replica.
>
> Until a cross-replica scheduler lands (Phase 12+), either run a **single
> replica**, or split into two Deployments: one 1-replica "worker" with
> `ION_TASKS_ENABLED=true` and an N-replica API tier with
> `ION_TASKS_ENABLED=false`. (Env vars are per pod template, so you cannot mix
> them inside one Deployment.)

## Service and Ingress

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ion-drive
spec:
  selector: { app: ion-drive }
  ports:
    - port: 80
      targetPort: 3000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ion-drive
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt   # or your issuer of choice
spec:
  ingressClassName: nginx
  tls:
    - hosts: [ion.example.com]
      secretName: ion-drive-tls
  rules:
    - host: ion.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ion-drive
                port: { number: 80 }
```

Terminate TLS at the ingress; the container itself speaks plain HTTP. Set
`ION_PUBLIC_URL` to the public HTTPS URL so auth issues correct base URLs.

## PostgreSQL

**Do not run Postgres inside the Ion Drive pod.** All platform state lives in
that one database; give it a real home:

- a **managed instance** (RDS, Cloud SQL, Neon, …) — simplest and recommended, or
- a Postgres **operator** in-cluster, e.g. [CloudNativePG](https://cloudnative-pg.io/),
  which handles volumes, failover, and backups properly.

Point `ION_DATABASE_URL` at it (add `?sslmode=require` when the network path
isn't private) and keep the database unreachable from outside the cluster/VPC.

## Metrics scraping

When `ION_METRICS_ENABLED=true` (the default) the server exposes Prometheus
text at `GET /metrics` on the main port. The pod annotations in the Deployment
above work with annotation-based Prometheus discovery; if you run the
Prometheus Operator, use a `PodMonitor`/`ServiceMonitor` targeting port 3000
and path `/metrics` instead.

> `/metrics` is **not authenticated** and is exempt from rate limiting. Don't
> route it through the public Ingress — keep it cluster-internal (the manifests
> above only expose it inside the cluster, which is what you want). See the
> [security checklist](security-checklist.md).

## What's deliberately not covered

- **Horizontal scaling** — see the replica caveat; there is no multi-node
  coordination story for scheduled tasks yet.
- **Multi-tenancy** — a single server serves a single database today.
- **Backups** — Kubernetes doesn't change the answer: back up Postgres and the
  two secret env vars. See [Backup & Restore](backup-restore.md).
