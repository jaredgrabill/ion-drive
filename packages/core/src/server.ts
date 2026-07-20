import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import pino from 'pino';
import pretty from 'pino-pretty';
import { registerAdminClaimRoutes } from './api/admin-claim-routes.js';
import { registerAdminRoutes } from './api/admin-routes.js';
import { installAdminStatic } from './api/admin-static.js';
import { registerBlockRoutes } from './api/block-routes.js';
import { installCors, resolveCorsOptions } from './api/cors-options.js';
import { registerDataRoutes } from './api/data-routes.js';
import { registerEventRoutes } from './api/event-routes.js';
import { registerGraphQLRoutes } from './api/graphql/plugin.js';
import { registerHookRoutes } from './api/hook-routes.js';
import { registerLogRoutes } from './api/log-routes.js';
import { registerOpenApiRoutes } from './api/openapi-routes.js';
import { installRateLimit } from './api/rate-limit-options.js';
import { registerSchemaRoutes } from './api/schema-routes.js';
import { registerStatsRoutes } from './api/stats-routes.js';
import { registerTaskRoutes } from './api/task-routes.js';
import { registerWebhookRoutes } from './api/webhook-admin-routes.js';
import {
  ANONYMOUS_ROLE_NAME,
  AdminClaimService,
  ApiKeyManager,
  BetterAuthProvider,
  PermissionEngine,
  RoleManager,
  RowPolicyResolver,
  bootstrapAdminFromEnv,
  createAnonymousCleanupHandler,
  deriveEmailDomain,
  ensureAnonymousCleanupTask,
  installRbacEnforcement,
  installSessionMiddleware,
  migrateAnonymousUser,
} from './auth/index.js';
import type { AnonymousAuthOptions } from './auth/index.js';
import { ACTION_REGISTRY, ActionExecutor, ActionRegistry, BlockEngine } from './blocks/index.js';
import { CACHE_SERVICE, MemoryCache } from './cache/index.js';
import {
  ConfigStore,
  Encryptor,
  type IonDriveConfig,
  SecretsManager,
  bootstrapPlatformTables,
  loadConfig,
} from './config/index.js';
import { DataService } from './data/index.js';
import { listRelationKeys } from './data/relation-keys.js';
import { createSystemDb, createTenantDb } from './db/index.js';
import { EMAIL_SERVICE, LogEmailProvider } from './email/index.js';
import { LOGGER_SERVICE, PinoLoggerProvider } from './logging/index.js';
import { registerMcpRoutes } from './mcp/plugin.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  EventDispatcher,
  EventStore,
  MESSAGE_BUS,
  type MessageBus,
  NoopBus,
  OutboxBus,
  RealtimeBridge,
  WebhookManager,
  WebhookStore,
  bootstrapEventTables,
  bootstrapWebhookTable,
  createPersistEventHandler,
  logEventHandler,
} from './messaging/index.js';
import { ServiceRegistry, loadPlugins } from './runtime/index.js';
import type { IonPlugin, PluginContext } from './runtime/index.js';
import { SchemaDoctor } from './schema/doctor.js';
import { SchemaManager } from './schema/index.js';
import { installSecurityAdvisories } from './security-advisories.js';
import { LocalStorage, STORAGE_SERVICE } from './storage/index.js';
import { TaskEngine } from './tasks/index.js';
import type { TaskLogger } from './tasks/index.js';
import {
  LogBuffer,
  createLogBufferStream,
  createOtelLogStream,
  installRequestTracing,
  startTelemetry,
} from './telemetry/index.js';

/** A fixed dev-only key so secrets/auth work out of the box; never for production. */
const DEV_FALLBACK_KEY = 'a'.repeat(64);

/** How long a signal-triggered shutdown may take before the process force-exits. */
const SHUTDOWN_GRACE_MS = 10_000;

/** The core package version, read once at boot (works from src and dist). */
const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

/**
 * Guards against the framework-mode "insecure default" (audit V1): a server
 * with RBAC enforcement disabled leaves **every** endpoint anonymous — anyone
 * can mint an admin-bound API key, drop tables, or read secrets. That is only
 * acceptable for local development, so in production we refuse to boot unless
 * the operator explicitly acknowledges an open deployment via
 * `ION_ALLOW_OPEN=true`. Called before any resource is acquired so the throw is
 * clean. Development/test still boot open (dev friction) but the caller logs a
 * loud error once Fastify exists.
 */
function assertSafeAuthPosture(config: IonDriveConfig): void {
  if (config.requireAuth || config.nodeEnv !== 'production' || config.allowOpen) return;
  throw new Error(
    'Refusing to boot: RBAC enforcement is disabled (ION_REQUIRE_AUTH is not set) in ' +
      'production, which leaves every endpoint anonymous — any caller could mint an ' +
      'admin API key, drop tables, or read secrets. Set ION_REQUIRE_AUTH=true. If (and ' +
      'only if) you truly intend an open, unauthenticated deployment, acknowledge it ' +
      'explicitly with ION_ALLOW_OPEN=true.',
  );
}

/**
 * Resolves the master secret for encryption and auth signing. Prefers an
 * explicitly-configured key; falls back to an insecure dev key with a warning.
 */
function resolveMasterSecret(config: IonDriveConfig, log: { warn: (msg: string) => void }): string {
  const key = config.encryptionKey ?? config.authSecret;
  if (key) return key;
  if (config.nodeEnv === 'production') {
    throw new Error('ION_ENCRYPTION_KEY (or ION_AUTH_SECRET) must be set in production');
  }
  log.warn(
    'No ION_ENCRYPTION_KEY set — using an insecure development key. Set one before production.',
  );
  return DEV_FALLBACK_KEY;
}

/** `value` when `enabled`, else undefined (keeps feature gates readable). */
function onlyIf<T>(enabled: boolean, value: T): T | undefined {
  return enabled ? value : undefined;
}

/**
 * Constant-time check of a `Authorization: Bearer <token>` header against the
 * configured metrics token (hashes both sides so lengths never leak).
 */
function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  return timingSafeEqual(presented, createHash('sha256').update(expected).digest());
}

/**
 * Registers `GET /metrics` (Prometheus text). When `ION_METRICS_TOKEN` is set,
 * scrapes must present it as a bearer token (Prometheus: the scrape config's
 * `authorization` block); otherwise the endpoint is open — see the security
 * checklist for keeping it network-internal in that case.
 */
function installMetricsEndpoint(
  server: FastifyInstance,
  telemetry: { renderPrometheus: () => Promise<string> },
  metricsToken: string | undefined,
): void {
  server.get('/metrics', async (request, reply) => {
    if (metricsToken && !bearerTokenMatches(request.headers.authorization, metricsToken)) {
      reply.code(401).header('www-authenticate', 'Bearer');
      return { error: 'Unauthorized', message: 'A valid metrics bearer token is required' };
    }
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return telemetry.renderPrometheus();
  });
}

/**
 * Mounts the built admin console SPA at `/admin` when enabled and installed
 * (Phase 14: framework mode). Logs the outcome either way; a missing admin
 * package is informational, not an error — core is fully usable headless.
 */
async function mountAdminConsole(server: FastifyInstance, config: IonDriveConfig): Promise<void> {
  if (!config.adminEnabled) {
    server.log.warn('Admin console serving disabled (ION_ADMIN_ENABLED=false)');
    return;
  }
  const mounted = await installAdminStatic(server, { distPath: config.adminDistPath });
  if (mounted) {
    server.log.info('Admin console mounted at /admin');
  } else {
    server.log.info(
      'Admin console not installed — add @ion-drive/admin (or set ION_ADMIN_DIST) to serve it at /admin',
    );
  }
}

/**
 * Builds the signup-lockout predicate for `ION_DISABLE_SIGNUP` (undefined when
 * the flag is off): signups are rejected once any role assignment exists —
 * i.e. once the first admin was created. Checked live per signup attempt so
 * removing every role assignment re-opens the bootstrap path rather than
 * locking the server permanently.
 */
function buildSignupGuard(
  config: IonDriveConfig,
  roleManager: RoleManager,
): (() => Promise<boolean>) | undefined {
  if (!config.disableSignup) return undefined;
  // Gate on the durable "bootstrap complete" marker, not a live count, so
  // removing every role assignment can't re-open public signup (audit V4).
  return async () => roleManager.isBootstrapComplete();
}

/**
 * Builds the user-created hook: the very first user to sign up becomes an
 * admin, so there is always a way in without a pre-seeded account. The grant
 * is serialized (see RoleManager.grantAdminIfFirstUser) so concurrent
 * first-boot sign-ups can't both become admin (audit V3). Anonymous (guest)
 * users are excluded from that bootstrap entirely — they get the seeded
 * `anonymous` role instead, and RoleManager ignores that role when deciding
 * whether the first admin exists.
 */
function buildUserCreatedHandler(
  server: FastifyInstance,
  roleManager: RoleManager,
): (user: { id: string; isAnonymous: boolean }) => Promise<void> {
  return async (user) => {
    if (user.isAnonymous) {
      const guestRole = await roleManager.getByName(ANONYMOUS_ROLE_NAME);
      if (guestRole) await roleManager.assign(user.id, guestRole.id);
      return;
    }
    if (await roleManager.grantAdminIfFirstUser(user.id)) {
      server.log.info(`Granted admin role to first user ${user.id}`);
    }
  };
}

/**
 * Seeds the disabled-by-default guest TTL cleanup task when anonymous auth is
 * on (idempotent by name; admins enable/tune it like any other task).
 */
async function seedAnonymousCleanupTask(
  config: IonDriveConfig,
  taskEngine: TaskEngine,
): Promise<void> {
  if (!config.anonymousAuth) return;
  await ensureAnonymousCleanupTask(taskEngine);
}

/**
 * Builds the Better Auth `anonymous` plugin options when ION_ANONYMOUS_AUTH is
 * on (undefined keeps the plugin unmounted and its endpoint a 404). On upgrade
 * (guest signs up with a real credential) Better Auth creates a NEW user and
 * deletes the guest; migrateAnonymousUser moves roles, API keys, and
 * created_by/updated_by stamps to the new id first, so the guest's data
 * survives the upgrade. See docs/concepts/auth.md for the semantics.
 */
function buildAnonymousOptions(
  config: IonDriveConfig,
  deps: {
    server: FastifyInstance;
    baseURL: string;
    systemDb: ReturnType<typeof createSystemDb>;
    tenantDb: ReturnType<typeof createTenantDb>;
    roleManager: RoleManager;
    schemaManager: SchemaManager;
  },
): AnonymousAuthOptions | undefined {
  if (!config.anonymousAuth) return undefined;
  const { server, baseURL, systemDb, tenantDb, roleManager, schemaManager } = deps;
  return {
    emailDomainName: deriveEmailDomain(baseURL),
    onLinkAccount: async ({ anonymousUserId, newUserId }) => {
      await migrateAnonymousUser(
        {
          systemDb,
          tenantDb,
          roleManager,
          listObjects: () => schemaManager.listObjects(),
          logger: {
            info: (msg) => server.log.info(msg),
            warn: (msg) => server.log.warn(msg),
          },
        },
        anonymousUserId,
        newUserId,
      );
    },
  };
}

/**
 * Builds the row-policy resolver (issue #7) under RBAC enforcement, or
 * undefined in open mode. Policy field references resolve through the live
 * schema registry (API name first, then physical column) so grants may use
 * either spelling — matching the query layer's field matching.
 */
function buildRowPolicyResolver(
  config: IonDriveConfig,
  permissionEngine: PermissionEngine,
  schemaManager: SchemaManager,
): RowPolicyResolver | undefined {
  if (!config.requireAuth) return undefined;
  return new RowPolicyResolver(permissionEngine, (objectName, field) => {
    const fields = schemaManager.registry.getFields(objectName);
    const def = fields.find((f) => f.name === field) ?? fields.find((f) => f.columnName === field);
    return def ? { column: def.columnName, columnType: def.columnType } : null;
  });
}

/**
 * Installs the global RBAC enforcement hook (config.requireAuth). The expand
 * resolver keeps anonymous public-read grants strictly per-object: an
 * anonymous `expand=` must also be granted on the target object (issue #8).
 */
function installEnforcement(
  server: FastifyInstance,
  config: IonDriveConfig,
  permissionEngine: PermissionEngine,
  schemaManager: SchemaManager,
): void {
  installRbacEnforcement(server, permissionEngine, {
    resolveExpandTarget: (objectName, relationKey) => {
      const obj = schemaManager.registry.getObject(objectName);
      if (!obj) return null;
      return listRelationKeys(obj).find((k) => k.key === relationKey)?.otherObject ?? null;
    },
  });
  server.log.info('RBAC enforcement enabled');
  if (config.publicRole) {
    server.log.info(
      'Public role active (ION_PUBLIC_ROLE): anonymous requests may read objects ' +
        'explicitly granted to the built-in "public" role (none by default)',
    );
  }
}

/**
 * Builds the webhook manager (Phase 12 / ADR-019) when the event system is on:
 * bootstraps `_ion_webhooks`, registers the `webhook` bus handler, and
 * re-registers every stored webhook's subscriptions. Returns undefined when
 * events are disabled — webhooks are event consumers, so they share the gate.
 */
async function buildWebhookManager(
  config: IonDriveConfig,
  tenantDb: Parameters<typeof bootstrapWebhookTable>[0],
  bus: MessageBus,
  encryptor: Encryptor,
  logger: PinoLoggerProvider,
): Promise<WebhookManager | undefined> {
  if (!config.eventsEnabled) return undefined;
  await bootstrapWebhookTable(tenantDb);
  const manager = new WebhookManager({ store: new WebhookStore(tenantDb), bus, encryptor, logger });
  await manager.initialize();
  return manager;
}

/**
 * Registers the Phase 12 event-edge routes: `/api/v1/webhooks` (any bus) and,
 * with the default outbox bus, `/api/v1/events` (ledger/DLQ + retry) plus the
 * realtime SSE bridge — the same gate as the dispatcher, since both read the
 * outbox directly. Returns the bridge so shutdown can stop it.
 */
async function registerEventEdge(
  server: FastifyInstance,
  deps: {
    config: IonDriveConfig;
    webhookManager: WebhookManager | undefined;
    eventStore: EventStore | undefined;
    bus: MessageBus;
    permissionEngine: PermissionEngine;
    rowPolicies: RowPolicyResolver | undefined;
  },
): Promise<RealtimeBridge | undefined> {
  const { config, webhookManager, eventStore, bus, permissionEngine } = deps;
  if (webhookManager) {
    await server.register(
      registerWebhookRoutes({ webhookManager, permissionEngine, enforce: config.requireAuth }),
      { prefix: '/api/v1/webhooks' },
    );
  }
  if (!config.eventsEnabled || !eventStore || !(bus instanceof OutboxBus)) return undefined;

  const realtime = new RealtimeBridge(eventStore, { pollIntervalMs: config.eventsPollIntervalMs });
  bus.setWakeHandler(() => realtime.trigger());
  await server.register(
    registerEventRoutes({
      eventStore,
      bus,
      permissionEngine,
      enforce: config.requireAuth,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      realtime,
      rowPolicies: deps.rowPolicies,
    }),
    { prefix: '/api/v1/events' },
  );
  return realtime;
}

/**
 * Builds the Fastify logger options. Logs always fan out via a pino
 * multistream to (a) the console (pretty in development, raw JSON otherwise)
 * and (b) the in-memory {@link LogBuffer} that backs the admin console's
 * `/api/v1/logs` view; when OTLP log export is enabled, the OpenTelemetry
 * logs bridge is added as a third arm.
 */
function buildLoggerOptions(config: IonDriveConfig, logBuffer: LogBuffer) {
  const level = config.logLevel;
  const streams: pino.StreamEntry[] = [
    config.nodeEnv === 'development'
      ? { level, stream: pretty({ colorize: true }) }
      : { level, stream: process.stdout },
    { level, stream: createLogBufferStream(logBuffer) },
  ];
  if (config.otelEnabled && config.otelLogsEnabled) {
    streams.push({ level, stream: createOtelLogStream() });
  }
  return { level, stream: pino.multistream(streams) };
}

/** Options accepted by {@link createServer}. */
export interface CreateServerOptions {
  /**
   * Plugins loaded during assembly, after core registers its default services
   * and before dependents are built — so a plugin can replace a service (cache,
   * email, bus, logger) or register block action/hook handlers. Runs *after*
   * any `ION_PLUGINS` env specifiers, so programmatic plugins win ties.
   */
  plugins?: IonPlugin[];
}

/**
 * Creates and configures a complete Ion Drive server (the **public framework
 * API** — see docs/concepts/framework-mode.md).
 *
 * A scaffolded project's `server.ts` is a thin composition root around this
 * call: it imports the vendored blocks barrel and passes it as `plugins`.
 *
 * Lifecycle:
 *  1. config is loaded/validated (`ION_*` env + `configOverrides`);
 *  2. core services and their defaults are registered;
 *  3. plugins run `setup` (may swap services / register handlers+actions);
 *  4. routes are registered; plugins' `onReady` runs;
 *  5. the caller `listen()`s on `handle.server`;
 *  6. `handle.close()` releases everything (plugins' `onShutdown`, schedulers,
 *     pools, telemetry) — SIGINT/SIGTERM call it automatically.
 *
 * Semver promise: the shape of {@link CreateServerOptions}, the returned
 * handle's documented members, and the `IonPlugin`/`PluginContext` contracts
 * follow semantic versioning — breaking changes to them mean a major release.
 */
export async function createServer(
  configOverrides?: Partial<IonDriveConfig>,
  options?: CreateServerOptions,
) {
  const config = loadConfig(configOverrides);

  // Fail fast on the insecure defaults (audit V1/V2) before acquiring any
  // resource: a production server with RBAC off must explicitly opt into open
  // mode, and a wildcard CORS origin with credentials is always refused.
  assertSafeAuthPosture(config);
  resolveCorsOptions(config);

  // In-memory log buffer for the admin console's instant-logs view. Created
  // before Fastify so the logger can fan out into it from the first line.
  const logBuffer = new LogBuffer(config.logBufferSize);

  const server = Fastify({
    logger: buildLoggerOptions(config, logBuffer),
    // Honour X-Forwarded-* only when explicitly configured (ION_TRUST_PROXY):
    // request.ip feeds the rate limiter, so trusting arbitrary clients' headers
    // would let them rotate buckets at will.
    trustProxy: config.trustProxy,
    // Streaming endpoints (the admin's SSE log tail, the Phase 12 event
    // stream) hold sockets open indefinitely; without force-close,
    // `server.close()` waits for them forever and the process never releases
    // the port. `'idle'` wouldn't help — an SSE response is never idle.
    forceCloseConnections: true,
  });

  // --- Observability (Phase 5): start the OTel SDK and per-request tracing ---
  const telemetry = startTelemetry(config, server.log);
  installRequestTracing(server);
  if (telemetry.metricsEndpointEnabled) {
    installMetricsEndpoint(server, telemetry, config.metricsToken);
  }

  // --- Security ---
  // CORS: same-origin by default, explicit allowlist when a separate frontend
  // origin needs credentialed access; a wildcard origin is refused (audit V2).
  await installCors(server, config);

  await server.register(helmet, {
    contentSecurityPolicy: config.nodeEnv === 'production',
  });

  // Per-IP rate limiting (config-gated, on by default): a generous global
  // bucket plus a stricter one for the Better Auth catch-all at /api/auth/*.
  // See api/rate-limit-options.ts for the bucket mechanics.
  await installRateLimit(server, config);

  // Boot-time security advisories (audit V6: open /metrics, non-production
  // posture) + a one-shot untrusted-proxy warning (audit V7).
  installSecurityAdvisories(server, config);

  // --- Database connections ---
  const systemDb = createSystemDb({ connectionString: config.databaseUrl });
  const tenantDb = createTenantDb({ connectionString: config.databaseUrl });

  // --- Phase 9: extensibility runtime (service registry, providers, message bus) ---
  // Register the default implementations first; plugins may replace any of them.
  const registry = new ServiceRegistry();
  const logger = new PinoLoggerProvider(server.log);
  registry.set(LOGGER_SERVICE, logger);
  registry.set(CACHE_SERVICE, new MemoryCache());
  registry.set(EMAIL_SERVICE, new LogEmailProvider(logger));
  registry.set(STORAGE_SERVICE, new LocalStorage(config.storageDir));

  // The default bus is the Postgres transactional outbox (co-located with the
  // tenant data so publishes are atomic with writes). Disabled → a no-op bus.
  let eventStore: EventStore | undefined;
  if (config.eventsEnabled) {
    await bootstrapEventTables(tenantDb);
    eventStore = new EventStore(tenantDb);
    registry.set(MESSAGE_BUS, new OutboxBus(eventStore));
  } else {
    registry.set(MESSAGE_BUS, new NoopBus());
    server.log.warn('Message bus disabled (ION_EVENTS_ENABLED=false) — no change events emitted');
  }

  // --- Schema Manager ---
  const schemaManager = new SchemaManager({ systemDb, tenantDb });
  await schemaManager.initialize();
  server.log.info(
    `Schema engine initialized — ${schemaManager.listObjects().length} object(s) loaded`,
  );

  // --- Plugins: run their setup so they can override services / register handlers ---
  // The action registry exists before plugins load so vendored block code can
  // register its action/hook handlers during setup (Phase 14).
  const actionRegistry = new ActionRegistry();
  registry.set(ACTION_REGISTRY, actionRegistry);
  const pluginContext: PluginContext = {
    registry,
    config,
    logger,
    // Live lookup: a plugin that swaps MESSAGE_BUS (e.g. plugin-redis) must be
    // visible to plugins loading after it, so `bus` re-resolves per access.
    get bus() {
      return registry.require(MESSAGE_BUS);
    },
    actions: actionRegistry,
  };
  const loadedPlugins = await loadPlugins({
    plugins: options?.plugins,
    specifiers: config.plugins,
    context: pluginContext,
  });

  // Resolve the final services after plugins have had their say.
  const bus = registry.require(MESSAGE_BUS);

  // --- Data Service (shared by the REST, GraphQL, and MCP surfaces) ---
  const dataService = new DataService(tenantDb, schemaManager.registry, bus);

  // Built-in bus handlers: `log_event` and `persist_event` (used by the audit
  // block). `persist_event` writes through the event-suppressing path so it
  // cannot recurse. Registered before the block engine re-registers its subs.
  bus.registerHandler(logEventHandler);
  bus.registerHandler(
    createPersistEventHandler({
      insert: (object, data) => dataService.insertSilent(object, data),
    }),
  );

  // --- Phase 4: platform tables, secrets, auth, and RBAC ---
  await bootstrapPlatformTables(systemDb);

  const masterSecret = resolveMasterSecret(config, server.log);
  const encryptor = new Encryptor(masterSecret);
  const secretsManager = new SecretsManager(systemDb, encryptor);
  const configStore = new ConfigStore(systemDb);
  const apiKeyManager = new ApiKeyManager(systemDb);
  const roleManager = new RoleManager(systemDb);
  await roleManager.seedDefaults();
  // Backfill the durable bootstrap marker for pre-marker deployments that
  // already have an admin, so the signup lockout is durable for them (V4).
  await roleManager.ensureBootstrapMarker();
  const permissionEngine = new PermissionEngine(roleManager, { publicRole: config.publicRole });

  // --- Row-level policies (issue #7 / Phase 17) ---
  // Wired only under RBAC enforcement, like the object-level hook: DataService
  // then scopes every read/write to the ambient principal's grant row
  // policies, and the realtime event filter row-scopes streamed data events.
  // Without enforcement (or with policy-less grants) behavior is unchanged.
  const rowPolicies = buildRowPolicyResolver(config, permissionEngine, schemaManager);
  dataService.setRowPolicyEnforcer(rowPolicies);

  // --- Phase 12: outbound webhooks (signed event push, riding the bus) ---
  // Works with any bus implementation; secrets are stored AES-encrypted in
  // the tenant DB. Built before the block engine so manifests declaring
  // webhooks can be provisioned/validated at install time.
  const webhookManager = await buildWebhookManager(config, tenantDb, bus, encryptor, logger);

  // --- Phase 5: task engine (scheduled/background tasks) ---
  const taskLogger: TaskLogger = {
    info: (msg, extra) => server.log.info(extra ?? {}, msg),
    warn: (msg, extra) => server.log.warn(extra ?? {}, msg),
    error: (msg, extra) => server.log.error(extra ?? {}, msg),
  };
  const taskEngine = new TaskEngine(systemDb, {
    logger: taskLogger,
    // The anonymous-cleanup handler is registered unconditionally so a stored
    // task definition always validates, even after ION_ANONYMOUS_AUTH is
    // turned back off (the handler no-ops when the column doesn't exist).
    handlers: [createAnonymousCleanupHandler({ tenantDb, systemDb })],
  });
  await taskEngine.initialize();
  await seedAnonymousCleanupTask(config, taskEngine);

  // --- Phase 6: building-blocks engine (installs domain blocks at runtime) ---
  const blockEngine = new BlockEngine(systemDb, {
    schemaManager,
    dataService,
    taskEngine,
    roleManager,
    bus,
    actionRegistry,
    webhookManager,
    pluginNames: loadedPlugins.plugins.map((p) => p.name),
    coreVersion: PACKAGE_VERSION,
  });
  await blockEngine.initialize();

  // --- Phase 14: action executor (shared by REST, MCP, and webhook hooks) ---
  const actionExecutor = new ActionExecutor({
    registry: actionRegistry,
    getInstalledBlock: (name) => blockEngine.getInstalled(name),
    listInstalledBlocks: () => blockEngine.listInstalled(),
    dataService,
    secrets: secretsManager,
    config,
    logger,
  });

  const baseURL = config.publicUrl ?? `http://localhost:${config.port}`;
  const trustedOrigins = [...new Set([config.adminUrl ?? 'http://localhost:3001', baseURL])];
  const authPool = new pg.Pool({ connectionString: config.databaseUrl });
  const authProvider = new BetterAuthProvider({
    pool: authPool,
    secret: config.authSecret ?? masterSecret,
    baseURL,
    trustedOrigins,
    // Hardening (ION_DISABLE_SIGNUP): close public signup once the first
    // admin exists.
    isSignupBlocked: buildSignupGuard(config, roleManager),
    // First-run bootstrap + guest routing — see buildUserCreatedHandler.
    onUserCreated: buildUserCreatedHandler(server, roleManager),
    // Anonymous (guest) sign-in — opt-in via ION_ANONYMOUS_AUTH; undefined
    // keeps the plugin (and its endpoint) unmounted.
    anonymous: buildAnonymousOptions(config, {
      server,
      baseURL,
      systemDb,
      tenantDb,
      roleManager,
      schemaManager,
    }),
  });
  await authProvider.initialize();
  server.log.info(`Auth provider "${authProvider.name}" initialized`);

  // --- Admin claim service (issue #32) ---
  // Owns the durable, service-only pending-claim marker (`_ion_config`, keyed
  // to the bootstrapped user's id) and the race-proof claim-completion logic.
  // Built before the bootstrap call below so it can mark the freshly created
  // admin pending-claim in the same boot sequence.
  const adminClaimService = new AdminClaimService({ systemDb, authProvider });

  // --- Env admin bootstrap (issue #26) ---
  // ION_ADMIN_EMAIL/ION_ADMIN_PASSWORD[_FILE]: on a database with zero
  // credentialed users, create the admin through the normal signup path (the
  // user-created hook grants first-admin exactly as a live signup would).
  // Runs here — after Better Auth's tables exist, before the server ever
  // listens — so no external request can race the zero-users check. When the
  // vars are set, ION_DISABLE_SIGNUP defaults to true (see loadConfig), so
  // the server comes up locked with a working admin in one step. The account
  // is also marked pending-claim (issue #32): first sign-in with the env
  // credential must complete onboarding before other admin UI is reachable.
  await bootstrapAdminFromEnv(config, {
    tenantDb,
    authProvider,
    roleManager,
    claimMarker: adminClaimService,
    log: {
      info: (msg) => server.log.info(msg),
      warn: (msg) => server.log.warn(msg),
    },
  });

  // Session resolution runs for every request; RBAC enforcement is opt-in.
  installSessionMiddleware(server, { provider: authProvider, apiKeys: apiKeyManager });
  if (config.requireAuth) {
    installEnforcement(server, config, permissionEngine, schemaManager);
  } else {
    // Open mode is only reachable here in development/test, or in production
    // with an explicit ION_ALLOW_OPEN acknowledgement (assertSafeAuthPosture).
    // Either way it is a security-relevant posture — log at error, not warn.
    server.log.error(
      'RBAC enforcement is DISABLED (ION_REQUIRE_AUTH not set) — every endpoint is ' +
        'anonymous. Set ION_REQUIRE_AUTH=true before exposing this server.',
    );
  }

  // --- Decorate Fastify with core services ---
  server.decorate('schemaManager', schemaManager);
  server.decorate('dataService', dataService);
  server.decorate('authProvider', authProvider);
  server.decorate('permissionEngine', permissionEngine);
  server.decorate('taskEngine', taskEngine);
  server.decorate('blockEngine', blockEngine);

  // --- Auth provider routes (login, logout, sessions) at /api/auth/* ---
  await authProvider.registerRoutes(server);

  // --- Health check ---
  server.get('/health', async () => ({
    status: 'ok',
    version: PACKAGE_VERSION,
    timestamp: new Date().toISOString(),
    schemaVersion: schemaManager.registry.getVersion(),
    objectCount: schemaManager.listObjects().length,
  }));

  // --- API info ---
  server.get('/api/v1', async () => ({
    name: 'Ion Drive',
    version: PACKAGE_VERSION,
    description: 'Dynamic data platform API',
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      schema: '/api/v1/schema',
      rest: '/api/v1/data/:objectName',
      graphql: '/api/v1/graphql',
      openapi: '/api/v1/openapi.json',
      mcp: '/api/v1/mcp',
      me: '/api/v1/me',
      roles: '/api/v1/roles',
      users: '/api/v1/users',
      secrets: '/api/v1/secrets',
      config: '/api/v1/config',
      apiKeys: '/api/v1/api-keys',
      tasks: '/api/v1/tasks',
      blocks: '/api/v1/blocks',
      events: '/api/v1/events',
      eventStream: '/api/v1/events/stream',
      webhooks: '/api/v1/webhooks',
      stats: '/api/v1/stats',
      logs: '/api/v1/logs',
      version: '/api/v1/version',
      metrics: '/metrics',
    },
  }));

  // --- Schema management routes (incl. snapshot + drift doctor, Phase 10) ---
  const schemaDoctor = new SchemaDoctor({
    tenantDb,
    registry: schemaManager.registry,
    configStore,
    // The auth provider's own tables (users, sessions, …) live in the tenant
    // database but are not Ion objects — don't report them as unmanaged drift.
    systemTables: authProvider.getManagedTables?.() ?? [],
  });
  await server.register(registerSchemaRoutes(schemaManager, { doctor: schemaDoctor }), {
    prefix: '/api/v1/schema',
  });

  // --- Dynamic REST data routes (auto-generated CRUD per object) ---
  await server.register(registerDataRoutes({ dataService, registry: schemaManager.registry }), {
    prefix: '/api/v1/data',
  });

  // --- OpenAPI spec (always current, generated from the live schema) ---
  await server.register(
    registerOpenApiRoutes(schemaManager.registry, {
      actionSurface: async () => ({
        actions: await actionExecutor.listDeclaredActions(),
        hooks: await actionExecutor.listDeclaredHooks(),
      }),
    }),
    { prefix: '/api/v1' },
  );

  // --- Phase 12: webhook management + event operations/realtime routes ---
  // Registered before GraphQL so the realtime bridge can back its
  // Subscription.events field (Phase 13).
  const realtime = await registerEventEdge(server, {
    config,
    webhookManager,
    eventStore,
    bus,
    permissionEngine,
    rowPolicies,
  });

  // --- GraphQL surface (graphql-yoga, schema reflected from the registry) ---
  await server.register(
    registerGraphQLRoutes({
      registry: schemaManager.registry,
      dataService,
      endpoint: '/api/v1/graphql',
      graphiql: config.nodeEnv !== 'production',
      actionExecutor,
      permissionEngine,
      enforce: config.requireAuth,
      realtime,
      rowPolicies,
    }),
  );

  // --- MCP server (Streamable HTTP, stateless) ---
  await server.register(
    registerMcpRoutes({
      schemaManager,
      dataService,
      actionExecutor,
      // list_blocks (ledger + provenance, spec-04) only when blocks are enabled.
      blockEngine: onlyIf(config.blocksEnabled, blockEngine),
      // Anonymous public-read mode (issue #8): read tools only, gated per
      // object through the public role.
      permissionEngine,
      enforce: config.requireAuth,
    }),
    { prefix: '/api/v1/mcp' },
  );

  // --- Admin / management routes (RBAC, users, secrets, config, API keys) ---
  await server.register(
    registerAdminRoutes({
      roleManager,
      permissionEngine,
      secretsManager,
      configStore,
      apiKeyManager,
      systemDb,
      claimService: adminClaimService,
      enforce: config.requireAuth,
    }),
    { prefix: '/api/v1' },
  );

  // --- Admin claim routes (issue #32 first-login onboarding) ---
  // Self-guarded on the requester's own session (see admin-claim-routes.ts);
  // deliberately NOT part of `installRbacEnforcement`'s requirement map, so
  // claim state can never gate the data/schema/GraphQL/MCP surfaces or
  // API-key access — see the module doc for why that is structural, not just
  // a convention.
  await server.register(registerAdminClaimRoutes({ claimService: adminClaimService }), {
    prefix: '/api/v1',
  });

  // --- Stats + version routes (dashboard snapshot, traffic, recent errors) ---
  await server.register(
    registerStatsRoutes({
      schemaManager,
      systemDb,
      permissionEngine,
      config,
      version: PACKAGE_VERSION,
      enforce: config.requireAuth,
    }),
    { prefix: '/api/v1' },
  );

  // --- Logs routes (in-memory buffer query + SSE live tail) ---
  await server.register(
    registerLogRoutes({ logBuffer, permissionEngine, enforce: config.requireAuth }),
    { prefix: '/api/v1/logs' },
  );

  // --- Task management routes (scheduled/background tasks) ---
  await server.register(
    registerTaskRoutes({ taskEngine, permissionEngine, enforce: config.requireAuth }),
    { prefix: '/api/v1/tasks' },
  );

  // --- Building-blocks routes (install/list/uninstall + actions, Phase 14) ---
  if (config.blocksEnabled) {
    await server.register(
      registerBlockRoutes({
        blockEngine,
        permissionEngine,
        actionExecutor,
        enforce: config.requireAuth,
      }),
      { prefix: '/api/v1/blocks' },
    );
    // Inbound webhooks for blocks with vendored logic. Session-auth exempt by
    // design (handlers verify provider signatures over the raw body).
    await server.register(registerHookRoutes({ actionExecutor }), { prefix: '/api/v1/hooks' });
  } else {
    server.log.warn('Building-blocks surface disabled (ION_BLOCKS_ENABLED=false)');
  }

  // --- Admin console SPA at /admin (Phase 14: framework mode) ---
  await mountAdminConsole(server, config);

  // --- Start the task scheduler once all routes are wired ---
  if (config.tasksEnabled) {
    await taskEngine.start();
  } else {
    server.log.warn('Task scheduler disabled (ION_TASKS_ENABLED=false)');
  }

  // --- Phase 9: start the event dispatcher (drains the outbox to subscribers) ---
  // Only for the default outbox bus; a replacement bus (e.g. a Redis plugin)
  // owns its own delivery loop.
  let dispatcher: EventDispatcher | undefined;
  if (config.eventsEnabled && eventStore && bus instanceof OutboxBus) {
    dispatcher = new EventDispatcher(eventStore, bus, {
      logger,
      pollIntervalMs: config.eventsPollIntervalMs,
    });
    dispatcher.start();
    server.log.info('Event dispatcher started');
  }

  // --- Let plugins run any post-assembly setup ---
  await loadedPlugins.runReady();

  // --- Graceful shutdown ---
  // `close` releases every resource createServer acquired (dispatcher, task
  // scheduler, plugins, HTTP server, telemetry, connection pools) without
  // exiting the process — programmatic embedders and integration tests call it
  // directly. The signal handlers wrap it with a process exit.
  //
  // Idempotent: every call shares one teardown promise. This is load-bearing,
  // not defensive — a signal can arrive after (or during) a programmatic close
  // (vitest's fork pool SIGTERMs its worker right after a suite that already
  // closed the server; tsx watch SIGTERMs on every file change). A second pass
  // used to double-end the auth pool ("Called end on pool more than once"),
  // abort before the system/tenant pools were destroyed, and leave the
  // shutdown handler hanging until its watchdog force-exited.
  const closeResources = async () => {
    dispatcher?.stop();
    realtime?.stop();
    taskEngine.stop();
    await loadedPlugins.runShutdown();
    await server.close();
    await telemetry.shutdown();
    await authPool.end();
    await systemDb.destroy();
    await tenantDb.destroy();
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= closeResources();
    return closing;
  };

  let shuttingDown = false;
  const shutdown = async () => {
    // A second Ctrl+C while a shutdown is in flight means "just die".
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    server.log.info('Shutting down...');
    // Watchdog: if any resource wedges during close (a stuck pool, a plugin
    // that never resolves), still exit so the port is released. `unref()` so
    // the timer itself can't keep a clean shutdown alive.
    setTimeout(() => {
      server.log.error(`Shutdown did not complete within ${SHUTDOWN_GRACE_MS}ms; forcing exit`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    // Exit deterministically either way — a rejected close must not strand
    // the process on the watchdog.
    try {
      await close();
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    server,
    config,
    registry,
    bus,
    schemaManager,
    dataService,
    authProvider,
    permissionEngine,
    roleManager,
    adminClaimService,
    secretsManager,
    apiKeyManager,
    taskEngine,
    blockEngine,
    actionRegistry,
    webhookManager,
    telemetry,
    logBuffer,
    close,
  };
}

/**
 * The handle returned by {@link createServer}: the Fastify instance plus every
 * assembled service, and `close()` for graceful programmatic shutdown.
 */
export type IonDriveServer = Awaited<ReturnType<typeof createServer>>;

/**
 * Starts the Ion Drive server.
 * Called directly when running `tsx watch src/server.ts` in development.
 */
async function main() {
  try {
    const { server, config } = await createServer();
    await server.listen({ port: config.port, host: config.host });
    server.log.info(`🚀 Ion Drive running at http://${config.host}:${config.port}`);
  } catch (err) {
    console.error('Failed to start Ion Drive:', err);
    process.exit(1);
  }
}

// Only boot when run directly (e.g. `tsx src/server.ts` or `node dist/server.js`),
// not when the module is imported as a library (index.ts re-exports createServer).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
