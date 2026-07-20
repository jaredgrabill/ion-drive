import 'dotenv/config';
import { z } from 'zod';

/** Guidance appended to every strict-boolean rejection message. */
const ENV_BOOL_HINT =
  'Accepted values: true, 1, yes, on (enable) or false, 0, no, off (disable), case-insensitive. Unset the variable to use its default.';

/** Spellings accepted as `true` by {@link envBool} (case-insensitive, trimmed). */
const ENV_BOOL_TRUE = new Set(['true', '1', 'yes', 'on']);
/** Spellings accepted as `false` by {@link envBool}. Empty string counts as false. */
const ENV_BOOL_FALSE = new Set(['false', '0', 'no', 'off', '']);

/**
 * Strictly parses a boolean env value. Never use `z.coerce.boolean` for env
 * flags: it is `Boolean(value)`, so every non-empty string — including
 * `"false"`, `"0"`, and `"no"` — is `true` (issue #25; `ION_OTEL_ENABLED=false`
 * used to *enable* telemetry, and for security flags the footgun cuts in the
 * dangerous direction).
 *
 * Accepted (case-insensitive, trimmed): `true`/`1`/`yes`/`on` → `true`;
 * `false`/`0`/`no`/`off`/`""` → `false`. Anything else fails config validation
 * at boot with a message naming the variable and the accepted values. Unset
 * still yields `defaultValue`.
 *
 * @param envVar - The environment variable name, used in the rejection message.
 * @param defaultValue - Value when the variable is unset.
 */
export const envBool = (envVar: string, defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      if (typeof v === 'boolean') return v;
      const normalized = v.trim().toLowerCase();
      if (ENV_BOOL_TRUE.has(normalized)) return true;
      if (ENV_BOOL_FALSE.has(normalized)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envVar} must be a boolean — got "${v}". ${ENV_BOOL_HINT}`,
      });
      return z.NEVER;
    });

/**
 * Non-schema variant of {@link envBool} for code that reads `process.env`
 * outside the config schema (e.g. first-party plugins). Same accepted
 * spellings; throws on anything else.
 */
export function parseEnvBool(
  envVar: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  const parsed = envBool(envVar, defaultValue).safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? `${envVar} must be a boolean`);
  }
  return parsed.data;
}

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

  /**
   * CORS allowed origins. Defaults to **`false`** — same-origin only (no
   * `Access-Control-Allow-Origin` header), because Ion Drive always sends
   * credentials (cookie auth) and a reflected/wildcard origin combined with
   * credentials is a cross-site request-forgery hole (audit V2). Set an
   * explicit allowlist (`ION_CORS_ORIGINS=https://app.example.com`) to permit a
   * separate frontend origin. A wildcard (`true`/`'*'`) is refused at boot.
   */
  corsOrigins: z.union([z.string(), z.array(z.string()), z.boolean()]).default(false),

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

  /**
   * When true, RBAC is enforced on data/schema/admin endpoints. Parsed with
   * the strict {@link envBool} so `ION_REQUIRE_AUTH=false` actually disables
   * enforcement (`z.coerce.boolean()` treats every non-empty string —
   * including "false" — as true, which silently ignored the off switch).
   */
  requireAuth: envBool('ION_REQUIRE_AUTH', false),

  /**
   * Explicit acknowledgement that this server is intended to run with RBAC
   * disabled ("open mode") — every endpoint anonymous. Required to boot in
   * production when {@link requireAuth} is off; ignored otherwise. Open mode is
   * always safe to boot in development/test (dev friction), but even then a
   * loud error is logged. Never set this on an internet-facing deployment
   * unless you truly mean "no authentication at all".
   */
  allowOpen: envBool('ION_ALLOW_OPEN', false),

  /**
   * Whether the built-in `public` role is evaluated for anonymous requests
   * (ION_PUBLIC_ROLE, issue #8). Default **on** — but structurally inert: the
   * role is seeded with zero grants, so nothing is publicly readable until an
   * admin explicitly grants `read` on a named object to it. The role is
   * read-only by construction (write/manage grants are rejected), so leaving
   * this on adds no exposure beyond what an admin deliberately grants. Set
   * false to hard-disable anonymous evaluation even when grants exist.
   */
  publicRole: envBool('ION_PUBLIC_ROLE', true),

  /**
   * When true, public signup closes once the first admin exists: the very
   * first user can still sign up (and becomes admin), after which
   * `/api/auth/sign-up/*` returns 403. Admins create further users directly.
   */
  disableSignup: envBool('ION_DISABLE_SIGNUP', false),

  /**
   * Enables anonymous (guest) sign-in via Better Auth's `anonymous` plugin:
   * `POST /api/auth/sign-in/anonymous` mints a real user (flagged
   * `isAnonymous`) with a session and the seeded `anonymous` role, upgradeable
   * later by signing up with a real credential (see docs/concepts/auth.md).
   * Default OFF — letting unauthenticated visitors mint users is a security
   * posture change, so it must be an explicit opt-in.
   */
  anonymousAuth: envBool('ION_ANONYMOUS_AUTH', false),

  // --- Rate limiting ---

  /** Enable per-IP HTTP rate limiting (global bucket + stricter auth bucket). */
  rateLimitEnabled: envBool('ION_RATE_LIMIT_ENABLED', true),

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
  otelEnabled: envBool('ION_OTEL_ENABLED', false),

  /** Logical service name reported on every span/metric/log. */
  otelServiceName: z.string().default('ion-drive'),

  /**
   * OTLP/HTTP base endpoint for traces and logs (e.g. an OTel Collector or Tempo).
   * The standard signal paths (`/v1/traces`, `/v1/logs`) are appended automatically.
   */
  otelExporterOtlpEndpoint: z.string().url().default('http://localhost:4318'),

  /** Export spans over OTLP/HTTP. Requires otelEnabled. */
  otelTracesEnabled: envBool('ION_OTEL_TRACES_ENABLED', true),

  /** Export logs over OTLP/HTTP (bridged from the Fastify/pino logger). Requires otelEnabled. */
  otelLogsEnabled: envBool('ION_OTEL_LOGS_ENABLED', false),

  /**
   * Expose a Prometheus scrape endpoint at `/metrics` on the main server.
   * Independent of otelEnabled so metrics work even without an OTLP backend.
   */
  metricsEnabled: envBool('ION_METRICS_ENABLED', true),

  /**
   * Optional bearer token protecting `GET /metrics`. When set, scrapes must
   * send `Authorization: Bearer <token>` (Prometheus: `authorization` in the
   * scrape config). Unset (the default) leaves the endpoint open — keep it
   * network-internal in that case (see the security checklist).
   */
  metricsToken: z.string().min(1).optional(),

  /** Also push metrics over OTLP/HTTP (in addition to the Prometheus endpoint). Requires otelEnabled. */
  otelMetricsEnabled: envBool('ION_OTEL_METRICS_ENABLED', false),

  /** Max entries held by the in-memory log buffer backing `/api/v1/logs`. */
  logBufferSize: z.coerce.number().int().positive().default(2000),

  // --- Phase 5: Scheduled tasks ---

  /** Enable the background task scheduler (cron-driven task execution). */
  tasksEnabled: envBool('ION_TASKS_ENABLED', true),

  // --- Phase 14: Admin console static serving ---

  /**
   * Serve the built admin console SPA at `/admin` when the
   * `@ion-drive/admin` package (or `ION_ADMIN_DIST`) is present.
   */
  adminEnabled: envBool('ION_ADMIN_ENABLED', true),

  /**
   * Explicit path to a built admin `dist/` directory. Overrides the default
   * lookup of the installed `@ion-drive/admin` package — useful in
   * the monorepo (point at `packages/admin/dist`) or for custom builds.
   */
  adminDistPath: z.string().optional(),

  // --- Phase 6: Building blocks ---

  /** Enable the building-blocks install surface (`/api/v1/blocks`). */
  blocksEnabled: envBool('ION_BLOCKS_ENABLED', true),

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

  /**
   * Root directory for the default filesystem blob store (the
   * {@link StorageProvider} port's `LocalStorage`). Relative paths resolve
   * against the working directory. An S3 plugin makes this irrelevant.
   */
  storageDir: z.string().default('.ion-storage'),

  /** Enable the message bus and CRUD change events (outbox + dispatcher). */
  eventsEnabled: envBool('ION_EVENTS_ENABLED', true),

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
    allowOpen: process.env.ION_ALLOW_OPEN,
    publicRole: process.env.ION_PUBLIC_ROLE,
    disableSignup: process.env.ION_DISABLE_SIGNUP,
    anonymousAuth: process.env.ION_ANONYMOUS_AUTH,
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
    storageDir: process.env.ION_STORAGE_DIR,
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
