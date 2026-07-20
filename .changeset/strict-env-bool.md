---
'@ion-drive/core': minor
'@ion-drive/plugin-redis': patch
'@ion-drive/plugin-storage-s3': patch
---

Strict boolean env-var parsing (issue #25). Every `ION_*` boolean flag now goes
through one shared `envBool` schema: `true`/`1`/`yes`/`on` enable,
`false`/`0`/`no`/`off` (or an empty value) disable, case-insensitive and
trimmed. Any other value refuses to boot with an error naming the variable and
the accepted spellings. Unset variables keep their existing defaults. The
parser is exported (`envBool`, `parseEnvBool`) for plugin authors, and the
first-party Redis (`ION_REDIS_BUS`) and S3 (`ION_S3_FORCE_PATH_STYLE`) plugins
now reject unrecognised spellings the same way.

**Behavior change — check your deployments.** `ION_OTEL_ENABLED`,
`ION_OTEL_LOGS_ENABLED`, and `ION_OTEL_METRICS_ENABLED` previously used
`z.coerce.boolean`, which treats **every non-empty string as true**: a
deployment that set `ION_OTEL_ENABLED=false` was actually running with
telemetry export **enabled** (and spamming `ECONNREFUSED` without a local
collector). With this release such values now mean what they say, so those
deployments will see telemetry genuinely switch off. Deployments that set any
boolean flag to an unrecognised value (e.g. `ION_TASKS_ENABLED=enabled`) will
now fail to boot with a clear message instead of silently misreading the flag —
fix the value or unset the variable. `ION_S3_FORCE_PATH_STYLE` set to an empty
string now means `false` (previously it fell back to the endpoint-derived
default); unset is unchanged.
