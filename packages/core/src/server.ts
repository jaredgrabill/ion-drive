import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import pg from 'pg';
import pino from 'pino';
import pretty from 'pino-pretty';
import { registerAdminRoutes } from './api/admin-routes.js';
import { registerBlockRoutes } from './api/block-routes.js';
import { registerDataRoutes } from './api/data-routes.js';
import { registerGraphQLRoutes } from './api/graphql/plugin.js';
import { registerLogRoutes } from './api/log-routes.js';
import { registerOpenApiRoutes } from './api/openapi-routes.js';
import { installRateLimit } from './api/rate-limit-options.js';
import { registerSchemaRoutes } from './api/schema-routes.js';
import { registerStatsRoutes } from './api/stats-routes.js';
import { registerTaskRoutes } from './api/task-routes.js';
import {
  ApiKeyManager,
  BetterAuthProvider,
  PermissionEngine,
  RoleManager,
  installRbacEnforcement,
  installSessionMiddleware,
} from './auth/index.js';
import { BlockEngine } from './blocks/index.js';
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
import { createSystemDb, createTenantDb } from './db/index.js';
import { EMAIL_SERVICE, LogEmailProvider } from './email/index.js';
import { LOGGER_SERVICE, PinoLoggerProvider } from './logging/index.js';
import { registerMcpRoutes } from './mcp/plugin.js';
import {
  EventDispatcher,
  EventStore,
  MESSAGE_BUS,
  NoopBus,
  OutboxBus,
  bootstrapEventTables,
  createPersistEventHandler,
  logEventHandler,
} from './messaging/index.js';
import { ServiceRegistry, loadPlugins } from './runtime/index.js';
import type { IonPlugin, PluginContext } from './runtime/index.js';
import { SchemaDoctor } from './schema/doctor.js';
import { SchemaManager } from './schema/index.js';
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

/** The core package version, read once at boot (works from src and dist). */
const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

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

/**
 * Creates and configures the Ion Drive Fastify server instance.
 *
 * This is the main entry point for the platform runtime. The server
 * dynamically registers API routes based on the current schema state
 * and provides REST, GraphQL, and MCP endpoints.
 */
export async function createServer(
  configOverrides?: Partial<IonDriveConfig>,
  options?: { plugins?: IonPlugin[] },
) {
  const config = loadConfig(configOverrides);

  // In-memory log buffer for the admin console's instant-logs view. Created
  // before Fastify so the logger can fan out into it from the first line.
  const logBuffer = new LogBuffer(config.logBufferSize);

  const server = Fastify({ logger: buildLoggerOptions(config, logBuffer) });

  // --- Observability (Phase 5): start the OTel SDK and per-request tracing ---
  const telemetry = startTelemetry(config, server.log);
  installRequestTracing(server);
  if (telemetry.metricsEndpointEnabled) {
    server.get('/metrics', async (_request, reply) => {
      reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      return telemetry.renderPrometheus();
    });
  }

  // --- Security ---
  await server.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });

  await server.register(helmet, {
    contentSecurityPolicy: config.nodeEnv === 'production',
  });

  // Per-IP rate limiting (config-gated, on by default): a generous global
  // bucket plus a stricter one for the Better Auth catch-all at /api/auth/*.
  // See api/rate-limit-options.ts for the bucket mechanics.
  await installRateLimit(server, config);

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
  const pluginContext: PluginContext = {
    registry,
    config,
    logger,
    bus: registry.require(MESSAGE_BUS),
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
  const permissionEngine = new PermissionEngine(roleManager);

  // --- Phase 5: task engine (scheduled/background tasks) ---
  const taskLogger: TaskLogger = {
    info: (msg, extra) => server.log.info(extra ?? {}, msg),
    warn: (msg, extra) => server.log.warn(extra ?? {}, msg),
    error: (msg, extra) => server.log.error(extra ?? {}, msg),
  };
  const taskEngine = new TaskEngine(systemDb, { logger: taskLogger });
  await taskEngine.initialize();

  // --- Phase 6: building-blocks engine (installs domain blocks at runtime) ---
  const blockEngine = new BlockEngine(systemDb, {
    schemaManager,
    dataService,
    taskEngine,
    roleManager,
    bus,
  });
  await blockEngine.initialize();

  const baseURL = config.publicUrl ?? `http://localhost:${config.port}`;
  const trustedOrigins = [...new Set([config.adminUrl ?? 'http://localhost:3001', baseURL])];
  const authPool = new pg.Pool({ connectionString: config.databaseUrl });
  const authProvider = new BetterAuthProvider({
    pool: authPool,
    secret: config.authSecret ?? masterSecret,
    baseURL,
    trustedOrigins,
    // First-run bootstrap: the very first user to sign up becomes an admin,
    // so there is always a way in without a pre-seeded account.
    onUserCreated: async (userId) => {
      if ((await roleManager.assignmentCount()) === 0) {
        const admin = await roleManager.getByName('admin');
        if (admin) {
          await roleManager.assign(userId, admin.id);
          server.log.info(`Granted admin role to first user ${userId}`);
        }
      }
    },
  });
  await authProvider.initialize();
  server.log.info(`Auth provider "${authProvider.name}" initialized`);

  // Session resolution runs for every request; RBAC enforcement is opt-in.
  installSessionMiddleware(server, { provider: authProvider, apiKeys: apiKeyManager });
  if (config.requireAuth) {
    installRbacEnforcement(server, permissionEngine);
    server.log.info('RBAC enforcement enabled');
  } else {
    server.log.warn('RBAC enforcement disabled (ION_REQUIRE_AUTH not set) — all endpoints open');
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
  await server.register(registerOpenApiRoutes(schemaManager.registry), { prefix: '/api/v1' });

  // --- GraphQL surface (graphql-yoga, schema reflected from the registry) ---
  await server.register(
    registerGraphQLRoutes({
      registry: schemaManager.registry,
      dataService,
      endpoint: '/api/v1/graphql',
      graphiql: config.nodeEnv !== 'production',
    }),
  );

  // --- MCP server (Streamable HTTP, stateless) ---
  await server.register(registerMcpRoutes({ schemaManager, dataService }), {
    prefix: '/api/v1/mcp',
  });

  // --- Admin / management routes (RBAC, users, secrets, config, API keys) ---
  await server.register(
    registerAdminRoutes({
      roleManager,
      permissionEngine,
      secretsManager,
      configStore,
      apiKeyManager,
      systemDb,
      enforce: config.requireAuth,
    }),
    { prefix: '/api/v1' },
  );

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

  // --- Building-blocks routes (install/list/uninstall domain blocks) ---
  if (config.blocksEnabled) {
    await server.register(
      registerBlockRoutes({ blockEngine, permissionEngine, enforce: config.requireAuth }),
      { prefix: '/api/v1/blocks' },
    );
  } else {
    server.log.warn('Building-blocks surface disabled (ION_BLOCKS_ENABLED=false)');
  }

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
  const close = async () => {
    dispatcher?.stop();
    taskEngine.stop();
    await loadedPlugins.runShutdown();
    await server.close();
    await telemetry.shutdown();
    await authPool.end();
    await systemDb.destroy();
    await tenantDb.destroy();
  };

  const shutdown = async () => {
    server.log.info('Shutting down...');
    await close();
    process.exit(0);
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
    secretsManager,
    apiKeyManager,
    taskEngine,
    blockEngine,
    telemetry,
    logBuffer,
    close,
  };
}

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
