/**
 * Env admin bootstrap integration suite (issue #26).
 *
 * Boots real servers via `createServer()` against throwaway scratch databases:
 *
 *   A — fresh DB + ION_ADMIN_EMAIL/ION_ADMIN_PASSWORD: boot creates the admin
 *       through the Better Auth signup path (sign-in works), grants admin like
 *       first-signup does, and signup starts LOCKED by default (no explicit
 *       ION_DISABLE_SIGNUP needed). A second boot against the same DB with the
 *       vars still set is a no-op.
 *   B — fresh DB without the vars: first-signup-wins is unchanged; the
 *       bootstrap helper itself no-ops once users exist and surfaces Better
 *       Auth's own password policy (no invented policy) as a boot error.
 *   C — ION_ADMIN_PASSWORD_FILE variant: file contents are trimmed.
 *
 * There is no race window to test against: the bootstrap runs inside
 * `createServer()` — before `listen()` is ever called — so no external signup
 * can interleave with the zero-users check.
 *
 * Run with a reachable Postgres 17 (defaults match CI's service container).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdminFromEnv } from '../auth/admin-bootstrap.js';
import { createTenantDb } from '../db/index.js';
import { createServer } from '../server.js';

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';

type Json = Record<string, unknown>;
type IonApp = Awaited<ReturnType<typeof createServer>>;

const BOOTSTRAP_EMAIL = 'root@ion.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-Passw0rd';

let adminClient: pg.Client | undefined;

function scratchUrl(db: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${db}`;
  return url.toString();
}

/** Base overrides shared by every boot in this suite. */
function baseOverrides(databaseUrl: string) {
  return {
    databaseUrl,
    requireAuth: false,
    allowOpen: true,
    nodeEnv: 'development' as const,
    rateLimitEnabled: false,
    otelEnabled: false,
    metricsEnabled: false,
    logLevel: 'fatal' as const,
  };
}

async function request(
  app: IonApp,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const res = await app.server.inject({
    method,
    url,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }
      : {}),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {} };
}

/** Count of accounts via the open users listing (enforcement is off). */
async function userCount(app: IonApp): Promise<number> {
  const res = await request(app, 'GET', '/api/v1/users');
  return ((res.body.data as Json[] | undefined) ?? []).length;
}

/** Waits for the scratch DB to have no sessions, then FORCE-drops it. */
async function drainThenDrop(db: string): Promise<void> {
  const started = Date.now();
  while (adminClient && Date.now() - started < 10_000) {
    const res = await adminClient.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [db],
    );
    if (res.rows[0].n === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await adminClient?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
}

beforeAll(async () => {
  adminClient = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5000 });
  try {
    await adminClient.connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Integration suite requires a reachable Postgres at ${ADMIN_URL}. Connection failed: ${reason}`,
    );
  }
}, 30_000);

afterAll(async () => {
  await adminClient?.end();
});

describe('A — fresh DB with ION_ADMIN_EMAIL/ION_ADMIN_PASSWORD', () => {
  const SCRATCH = `ion_bootstrap_${randomBytes(6).toString('hex')}`;
  let app: IonApp | undefined;

  beforeAll(async () => {
    await adminClient?.query(`CREATE DATABASE ${SCRATCH}`);
    app = await createServer({
      ...baseOverrides(scratchUrl(SCRATCH)),
      adminEmail: BOOTSTRAP_EMAIL,
      adminPassword: BOOTSTRAP_PASSWORD,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await drainThenDrop(SCRATCH);
  }, 60_000);

  it('creates exactly one admin account at boot and grants it the admin role', async () => {
    if (!app) throw new Error('Server not booted');
    expect(await userCount(app)).toBe(1);
    const adminRole = await app.roleManager.getByName('admin');
    expect(adminRole).toBeDefined();
    const holders = await app.roleManager.getUsersForRole((adminRole as { id: string }).id);
    expect(holders).toHaveLength(1);
  });

  it('the bootstrapped admin can sign in through the normal auth route', async () => {
    if (!app) throw new Error('Server not booted');
    const res = await request(app, 'POST', '/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect((res.body.user as Json).email).toBe(BOOTSTRAP_EMAIL);
  });

  it('locks public signup by default (no explicit ION_DISABLE_SIGNUP)', async () => {
    if (!app) throw new Error('Server not booted');
    expect(app.config.disableSignup).toBe(true);
    const res = await request(app, 'POST', '/api/auth/sign-up/email', {
      email: 'interloper@ion.test',
      password: 'interloper-Passw0rd',
      name: 'Interloper',
    });
    expect(res.status).toBe(403);
    expect(await userCount(app)).toBe(1);
  });

  it('a second boot against the same DB with the vars still set is a no-op', async () => {
    if (!app) throw new Error('Server not booted');
    await app.close();
    app = await createServer({
      ...baseOverrides(scratchUrl(SCRATCH)),
      adminEmail: BOOTSTRAP_EMAIL,
      adminPassword: BOOTSTRAP_PASSWORD,
    });
    expect(await userCount(app)).toBe(1);
    // The original credential still works — nothing was rotated or duplicated.
    const res = await request(app, 'POST', '/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(res.status).toBe(200);
  }, 120_000);

  it('re-creates the admin after a user-table wipe, despite the durable signup-lock marker', async () => {
    if (!app) throw new Error('Server not booted');
    // Simulate an operator wiping the auth tables AFTER bootstrap completed:
    // the durable `bootstrap.completed` marker in _ion_config survives (it is
    // what keeps PUBLIC signup permanently closed — audit V4). A reboot with
    // the ION_ADMIN_* vars must not crash into that lock: the bootstrap's
    // account creation is administrative and exempt from it.
    await app.close();
    const wipe = new pg.Client({ connectionString: scratchUrl(SCRATCH) });
    await wipe.connect();
    await wipe.query('DELETE FROM "_ion_user_roles"');
    await wipe.query('DELETE FROM "session"');
    await wipe.query('DELETE FROM "account"');
    await wipe.query('DELETE FROM "user"');
    await wipe.end();

    app = await createServer({
      ...baseOverrides(scratchUrl(SCRATCH)),
      adminEmail: BOOTSTRAP_EMAIL,
      adminPassword: BOOTSTRAP_PASSWORD,
    });

    // The admin is back, with the admin role granted (via the backstop —
    // grantAdminIfFirstUser declines because the marker exists).
    expect(await userCount(app)).toBe(1);
    const adminRole = await app.roleManager.getByName('admin');
    const holders = await app.roleManager.getUsersForRole((adminRole as { id: string }).id);
    expect(holders).toHaveLength(1);
    const signin = await request(app, 'POST', '/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signin.status).toBe(200);

    // PUBLIC signup on the very same booted server is still locked — the
    // administrative exemption did not weaken the public lockout.
    const signup = await request(app, 'POST', '/api/auth/sign-up/email', {
      email: 'wiper@ion.test',
      password: 'wiper-Passw0rd',
    });
    expect(signup.status).toBe(403);
    expect(await userCount(app)).toBe(1);
  }, 120_000);
});

describe('B — fresh DB without the vars (first-signup-wins unchanged)', () => {
  const SCRATCH = `ion_bootstrap_${randomBytes(6).toString('hex')}`;
  let app: IonApp | undefined;
  let tenantDb: ReturnType<typeof createTenantDb> | undefined;

  beforeAll(async () => {
    await adminClient?.query(`CREATE DATABASE ${SCRATCH}`);
    app = await createServer(baseOverrides(scratchUrl(SCRATCH)));
    tenantDb = createTenantDb({ connectionString: scratchUrl(SCRATCH) });
  }, 120_000);

  afterAll(async () => {
    await tenantDb?.destroy();
    await app?.close();
    await drainThenDrop(SCRATCH);
  }, 60_000);

  it('surfaces Better Auth password policy as a clear error, creating nothing', async () => {
    if (!app || !tenantDb) throw new Error('Server not booted');
    // Zero users at this point, so the bootstrap would otherwise proceed —
    // the weak password must be rejected by Better Auth's own signup policy
    // (min length 8 by default), mapped to a message naming the variables.
    await expect(
      bootstrapAdminFromEnv(
        { ...app.config, adminEmail: BOOTSTRAP_EMAIL, adminPassword: 'short' },
        {
          tenantDb,
          authProvider: app.authProvider,
          roleManager: app.roleManager,
          log: { info: () => {}, warn: () => {} },
        },
      ),
    ).rejects.toThrow(/ION_ADMIN_EMAIL\/ION_ADMIN_PASSWORD/);
    expect(await userCount(app)).toBe(0);
  });

  it('keeps first-signup-wins: the first public signup becomes admin', async () => {
    if (!app) throw new Error('Server not booted');
    const res = await request(app, 'POST', '/api/auth/sign-up/email', {
      email: 'first@ion.test',
      password: 'first-Passw0rd',
      name: 'First',
    });
    expect(res.status).toBe(200);
    const adminRole = await app.roleManager.getByName('admin');
    const holders = await app.roleManager.getUsersForRole((adminRole as { id: string }).id);
    expect(holders).toHaveLength(1);
  });

  it('no-ops (single info line) once users exist, even with valid credentials', async () => {
    if (!app || !tenantDb) throw new Error('Server not booted');
    const infoLines: string[] = [];
    await bootstrapAdminFromEnv(
      { ...app.config, adminEmail: BOOTSTRAP_EMAIL, adminPassword: BOOTSTRAP_PASSWORD },
      {
        tenantDb,
        authProvider: app.authProvider,
        roleManager: app.roleManager,
        log: { info: (msg) => infoLines.push(msg), warn: () => {} },
      },
    );
    expect(await userCount(app)).toBe(1);
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]).toContain('ION_ADMIN_EMAIL ignored');
    // The password value never appears in what was logged.
    expect(infoLines.join('\n')).not.toContain(BOOTSTRAP_PASSWORD);
  });
});

describe('C — ION_ADMIN_PASSWORD_FILE variant', () => {
  const SCRATCH = `ion_bootstrap_${randomBytes(6).toString('hex')}`;
  let app: IonApp | undefined;
  let secretDir: string | undefined;

  beforeAll(async () => {
    await adminClient?.query(`CREATE DATABASE ${SCRATCH}`);
    secretDir = mkdtempSync(join(tmpdir(), 'ion-admin-secret-'));
    // Secret mounts routinely append a trailing newline — it must be trimmed.
    writeFileSync(join(secretDir, 'admin-password'), `${BOOTSTRAP_PASSWORD}\n`, 'utf8');
    app = await createServer({
      ...baseOverrides(scratchUrl(SCRATCH)),
      adminEmail: BOOTSTRAP_EMAIL,
      adminPasswordFile: join(secretDir, 'admin-password'),
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await drainThenDrop(SCRATCH);
    if (secretDir) rmSync(secretDir, { recursive: true, force: true });
  }, 60_000);

  it('reads and trims the password file; the admin can sign in; signup is locked', async () => {
    if (!app) throw new Error('Server not booted');
    expect(await userCount(app)).toBe(1);
    const signin = await request(app, 'POST', '/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signin.status).toBe(200);
    const signup = await request(app, 'POST', '/api/auth/sign-up/email', {
      email: 'late@ion.test',
      password: 'late-Passw0rd',
    });
    expect(signup.status).toBe(403);
  });
});
