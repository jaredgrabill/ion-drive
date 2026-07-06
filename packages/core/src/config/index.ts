import 'dotenv/config';
import { z } from 'zod';

/**
 * Parses a boolean from an environment string. Unlike `z.coerce.boolean`
 * (which treats every non-empty string as `true`, so `"false"` becomes `true`),
 * this recognises the usual falsy spellings — essential for flags that default
 * to `true` and must be switchable off via an env var.
 */
const envBoolean = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      return !['false', '0', 'no', 'off', ''].includes(v.trim().toLowerCase());
    });

/**
 * Ion Drive configuration schema.
 *
 * All configuration is loaded from environment variables with sensible defaults.
 * This makes deployment straightforward: set env vars or use a .env file.
 */
const configSchema = z.object({
  /** Server port */
  port: z.coerce.number().int().positive().default(3000),

  /** Server host */
  host: z.string().default('0.0.0.0'),

  /** Node environment */
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  /** Log level */
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** PostgreSQL connection URL for the system database */
  databaseUrl: z.string().url().default('postgresql://ion:ion@localhost:5432/ion_drive'),

  /** CORS allowed origins */
  corsOrigins: z.union([z.string(), z.array(z.string()), z.boolean()]).default(true),

  /**
   * Fastify `trustProxy` setting — controls whether `X-Forwarded-*` headers
   * are honoured for `request.ip` (which the rate limiter keys on) and
   * protocol/host derivation. Accepts `true`/`false`, a hop count (`1`), or
   * a comma-separated list of trusted proxy addresses/CIDRs. Keep it `false`
   * unless the server actually sits behind a proxy you control — trusting
   * forwarded headers from arbitrary clients lets them spoof their IP.
   */
  trustProxy: z
    .union([z.boolean(), z.number(), z.string()])
    .default(false)
    .transform((v): boolean | number | string => {
      if (typeof v !== 'string') return v;
      const s = v.trim();
      if (['true', 'yes', 'on'].includes(s.toLowerCase())) return true;
      if (['false', 'no', 'off', ''].includes(s.toLowerCase())) return false;
      if (/^\d+$/.test(s)) return Number(s);
      return s; // address / CIDR list, passed to Fastify verbatim
    }),

  /** Encryption key for secrets management (32-byte hex string) */
  encryptionKey: z.string().min(64).optional(),

  /** Secret used to sign auth sessions/tokens. Falls back to the encryption key. */
  authSecret: z.string().min(16).optional(),

  /** When true, RBAC is enforced on data/schema/admin endpoints. */
  requireAuth: z.coerce.boolean().default(false),

  /**
   * When true, public signup closes once the first admin exists: the very
   * first user can still sign up (and becomes admin), after which
   * `/api/auth/sign-up/*` returns 403. Admins create further users directly.
   */
  disableSignup: envBoolean(false),

  // --- Rate limiting ---

  /** Enable per-IP HTTP rate limiting (global bucket + stricter auth bucket). */
  rateLimitEnabled: envBoolean(true),

  /** Max requests per IP per window for the global bucket. */
  rateLimitMax: z.coerce.number().int().positive().default(300),

  /** Rate-limit window length in milliseconds (shared by both buckets). */
  rateLimitWindowMs: z.coerce.number().int().positive().default(60000),

  /** Stricter max requests per IP per window for auth endpoints (`/api/auth/*`). */
  rateLimitAuthMax: z.coerce.number().int().positive().default(20),

  /** Public base URL of this server (used as the auth baseURL). */
  publicUrl: z.string().url().optional(),

  /** Base URL for the admin console (used for CORS and redirects) */
  adminUrl: z.string().url().optional(),

  // --- Phase 5: Observability (OpenTelemetry) ---

  /** Master switch for the OpenTelemetry SDK (traces + metrics + logs export). */
  otelEnabled: z.coerce.boolean().default(false),

  /** Logical service name reported on every span/metric/log. */
  otelServiceName: z.string().default('ion-drive'),

  /**
   * OTLP/HTTP base endpoint for traces and logs (e.g. an OTel Collector or Tempo).
   * The standard signal paths (`/v1/traces`, `/v1/logs`) are appended automatically.
   */
  otelExporterOtlpEndpoint: z.string().url().default('http://localhost:4318'),

  /** Export spans over OTLP/HTTP. Requires otelEnabled. */
  otelTracesEnabled: envBoolean(true),

  /** Export logs over OTLP/HTTP (bridged from the Fastify/pino logger). Requires otelEnabled. */
  otelLogsEnabled: z.coerce.boolean().default(false),

  /**
   * Expose a Prometheus scrape endpoint at `/metrics` on the main server.
   * Independent of otelEnabled so metrics work even without an OTLP backend.
   */
  metricsEnabled: envBoolean(true),

  /**
   * Optional bearer token protecting `GET /metrics`. When set, scrapes must
   * send `Authorization: Bearer <token>` (Prometheus: `authorization` in the
   * scrape config). Unset (the default) leaves the endpoint open — keep it
   * network-internal in that case (see the security checklist).
   */
  metricsToken: z.string().min(1).optional(),

  /** Also push metrics over OTLP/HTTP (in addition to the Prometheus endpoint). Requires otelEnabled. */
  otelMetricsEnabled: z.coerce.boolean().default(false),

  /** Max entries held by the in-memory log buffer backing `/api/v1/logs`. */
  logBufferSize: z.coerce.number().int().positive().default(2000),

  // --- Phase 5: Scheduled tasks ---

  /** Enable the background task scheduler (cron-driven task execution). */
  tasksEnabled: envBoolean(true),

  // --- Phase 14: Admin console static serving ---

  /**
   * Serve the built admin console SPA at `/admin` when the
   * `@ion-drive/admin` package (or `ION_ADMIN_DIST`) is present.
   */
  adminEnabled: envBoolean(true),

  /**
   * Explicit path to a built admin `dist/` directory. Overrides the default
   * lookup of the installed `@ion-drive/admin` package — useful in
   * the monorepo (point at `packages/admin/dist`) or for custom builds.
   */
  adminDistPath: z.string().optional(),

  // --- Phase 6: Building blocks ---

  /** Enable the building-blocks install surface (`/api/v1/blocks`). */
  blocksEnabled: envBoolean(true),

  // --- Phase 9: Extensibility (plugins + message bus) ---

  /**
   * Plugin module specifiers to load at boot (comma-separated in `ION_PLUGINS`).
   * Each is dynamically imported; its default export must be an Ion Drive plugin.
   */
  plugins: z
    .union([z.string(), z.array(z.string())])
    .default([])
    .transform((v) =>
      Array.isArray(v)
        ? v
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    ),

  /** Enable the message bus and CRUD change events (outbox + dispatcher). */
  eventsEnabled: envBoolean(true),

  /**
   * How often (ms) the event dispatcher polls the outbox for undelivered
   * events. A commit also nudges the dispatcher, so this is mainly the fallback
   * cadence and the pickup interval for events published by other instances.
   */
  eventsPollIntervalMs: z.coerce.number().int().positive().default(2000),
});

export type IonDriveConfig = z.infer<typeof configSchema>;

/**
 * Loads configuration from environment variables, validates with Zod,
 * and merges with any provided overrides.
 *
 * @param overrides - Partial config to merge (useful for testing)
 * @returns Validated configuration object
 */
export function loadConfig(overrides?: Partial<IonDriveConfig>): IonDriveConfig {
  const envConfig = {
    port: process.env.ION_PORT ?? process.env.PORT,
    host: process.env.ION_HOST,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.ION_LOG_LEVEL ?? process.env.LOG_LEVEL,
    databaseUrl: process.env.ION_DATABASE_URL ?? process.env.DATABASE_URL,
    corsOrigins: process.env.ION_CORS_ORIGINS,
    trustProxy: process.env.ION_TRUST_PROXY,
    encryptionKey: process.env.ION_ENCRYPTION_KEY,
    authSecret: process.env.ION_AUTH_SECRET,
    requireAuth: process.env.ION_REQUIRE_AUTH,
    disableSignup: process.env.ION_DISABLE_SIGNUP,
    rateLimitEnabled: process.env.ION_RATE_LIMIT_ENABLED,
    rateLimitMax: process.env.ION_RATE_LIMIT_MAX,
    rateLimitWindowMs: process.env.ION_RATE_LIMIT_WINDOW_MS,
    rateLimitAuthMax: process.env.ION_RATE_LIMIT_AUTH_MAX,
    publicUrl: process.env.ION_PUBLIC_URL,
    adminUrl: process.env.ION_ADMIN_URL,
    otelEnabled: process.env.ION_OTEL_ENABLED,
    otelServiceName: process.env.ION_OTEL_SERVICE_NAME ?? process.env.OTEL_SERVICE_NAME,
    otelExporterOtlpEndpoint:
      process.env.ION_OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelTracesEnabled: process.env.ION_OTEL_TRACES_ENABLED,
    otelLogsEnabled: process.env.ION_OTEL_LOGS_ENABLED,
    metricsEnabled: process.env.ION_METRICS_ENABLED,
    metricsToken: process.env.ION_METRICS_TOKEN,
    otelMetricsEnabled: process.env.ION_OTEL_METRICS_ENABLED,
    logBufferSize: process.env.ION_LOG_BUFFER_SIZE,
    tasksEnabled: process.env.ION_TASKS_ENABLED,
    adminEnabled: process.env.ION_ADMIN_ENABLED,
    adminDistPath: process.env.ION_ADMIN_DIST,
    blocksEnabled: process.env.ION_BLOCKS_ENABLED,
    plugins: process.env.ION_PLUGINS,
    eventsEnabled: process.env.ION_EVENTS_ENABLED,
    eventsPollIntervalMs: process.env.ION_EVENTS_POLL_INTERVAL_MS,
  };

  // Remove undefined values so Zod defaults kick in
  const cleaned = Object.fromEntries(
    Object.entries({ ...envConfig, ...overrides }).filter(([, v]) => v !== undefined),
  );

  const result = configSchema.safeParse(cleaned);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid Ion Drive configuration:\n${errors}`);
  }

  return result.data;
}

// --- Platform config & secrets ---
export { Encryptor, generateEncryptionKey } from './encryption.js';
export { ConfigStore } from './config-store.js';
export { SecretsManager } from './secrets-manager.js';
export type { SecretMetadata } from './secrets-manager.js';
export { bootstrapPlatformTables } from './platform-tables.js';
