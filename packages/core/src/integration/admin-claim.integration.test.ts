/**
 * Admin claim flow integration suite (issue #32).
 *
 * Boots real servers via `createServer()` against throwaway scratch databases
 * and exercises the first-login "claim" flow that follows env-var admin
 * bootstrap (issue #26): the happy path, then the full adversarial matrix
 * from the issue's "Security invariants (NON-NEGOTIABLE)" section — every
 * case must fail closed.
 *
 * Run with a reachable Postgres 17 (defaults match CI's service container).
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

const ADMIN_URL = process.env.ION_DATABASE_URL ?? 'postgresql://ion:ion@localhost:5432/ion_drive';

type Json = Record<string, unknown>;
type IonApp = Awaited<ReturnType<typeof createServer>>;

const BOOTSTRAP_EMAIL = 'root@ion.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-Passw0rd';
const NEW_PASSWORD = 'claimed-Passw0rd-2';

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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json }> {
  const res = await app.server.inject({
    method,
    url,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {} };
}

/** Signs in and returns a bearer Authorization header for the new session (issue #24). */
async function signIn(
  app: IonApp,
  email: string,
  password: string,
): Promise<{ status: number; body: Json; authHeader?: Record<string, string> }> {
  const res = await request(app, 'POST', '/api/auth/sign-in/email', { body: { email, password } });
  const token = (res.body as { token?: string }).token;
  return {
    status: res.status,
    body: res.body,
    authHeader: token ? { authorization: `Bearer ${token}` } : undefined,
  };
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

describe('Happy path — bootstrap, forced onboarding, claim, rotated credential', () => {
  const SCRATCH = `ion_claim_${randomBytes(6).toString('hex')}`;
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

  it('marks the freshly bootstrapped admin pending-claim', async () => {
    if (!app) throw new Error('Server not booted');
    const adminRole = await app.roleManager.getByName('admin');
    const holders = await app.roleManager.getUsersForRole((adminRole as { id: string }).id);
    expect(holders).toHaveLength(1);
    expect(await app.adminClaimService.isPendingClaim(holders[0] as string)).toBe(true);
  });

  it('signing in with the bootstrap credential surfaces pendingClaim: true on /api/v1/me', async () => {
    if (!app) throw new Error('Server not booted');
    const signin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(signin.status).toBe(200);
    const me = await request(app, 'GET', '/api/v1/me', { headers: signin.authHeader });
    expect(me.body.authenticated).toBe(true);
    expect(me.body.pendingClaim).toBe(true);
  });

  it('rejects a claim whose new password and confirmation do not match', async () => {
    if (!app) throw new Error('Server not booted');
    const signin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const res = await request(app, 'POST', '/api/v1/admin-claim', {
      body: { name: 'Ada', newPassword: NEW_PASSWORD, confirmPassword: 'not-the-same' },
      headers: signin.authHeader,
    });
    expect(res.status).toBe(400);
  });

  it('completes the claim: sets the display name, rotates the password, clears the marker', async () => {
    if (!app) throw new Error('Server not booted');
    const signin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(signin.status).toBe(200);

    const claim = await request(app, 'POST', '/api/v1/admin-claim', {
      body: { name: 'Ada Lovelace', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      headers: signin.authHeader,
    });
    expect(claim.status).toBe(200);

    const adminRole = await app.roleManager.getByName('admin');
    const holders = await app.roleManager.getUsersForRole((adminRole as { id: string }).id);
    expect(await app.adminClaimService.isPendingClaim(holders[0] as string)).toBe(false);

    // Same session, no re-login needed: /me now reports the new name and
    // pendingClaim: false.
    const me = await request(app, 'GET', '/api/v1/me', { headers: signin.authHeader });
    expect(me.body.pendingClaim).toBe(false);
    expect((me.body.user as Json).name).toBe('Ada Lovelace');

    // The old env password is dead; the new one works.
    const oldSignin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(oldSignin.status).not.toBe(200);
    const newSignin = await signIn(app, BOOTSTRAP_EMAIL, NEW_PASSWORD);
    expect(newSignin.status).toBe(200);
  });

  it('replaying the claim after completion fails closed (409), leaving the account untouched', async () => {
    if (!app) throw new Error('Server not booted');
    const signin = await signIn(app, BOOTSTRAP_EMAIL, NEW_PASSWORD);
    expect(signin.status).toBe(200);
    const replay = await request(app, 'POST', '/api/v1/admin-claim', {
      body: {
        name: 'Replayed Name',
        newPassword: 'replay-Passw0rd',
        confirmPassword: 'replay-Passw0rd',
      },
      headers: signin.authHeader,
    });
    expect(replay.status).toBe(409);

    const me = await request(app, 'GET', '/api/v1/me', { headers: signin.authHeader });
    expect((me.body.user as Json).name).toBe('Ada Lovelace');
    const replaySignin = await signIn(app, BOOTSTRAP_EMAIL, 'replay-Passw0rd');
    expect(replaySignin.status).not.toBe(200);
  });

  it('a second boot with the vars still set stays a no-op — the claim is not undone', async () => {
    if (!app) throw new Error('Server not booted');
    await app.close();
    app = await createServer({
      ...baseOverrides(scratchUrl(SCRATCH)),
      adminEmail: BOOTSTRAP_EMAIL,
      adminPassword: BOOTSTRAP_PASSWORD,
    });
    expect(await userCount(app)).toBe(1);
    const adminRole = await app.roleManager.getByName('admin');
    const holders = await app.roleManager.getUsersForRole((adminRole as { id: string }).id);
    expect(await app.adminClaimService.isPendingClaim(holders[0] as string)).toBe(false);

    const oldSignin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(oldSignin.status).not.toBe(200);
    const claimedSignin = await signIn(app, BOOTSTRAP_EMAIL, NEW_PASSWORD);
    expect(claimedSignin.status).toBe(200);
  }, 120_000);
});

describe('Adversarial matrix — every case must fail closed', () => {
  const SCRATCH = `ion_claim_adv_${randomBytes(6).toString('hex')}`;
  let app: IonApp | undefined;
  let bootstrapUserId: string;
  let lowPrivEmail: string;
  let lowPrivPassword: string;

  beforeAll(async () => {
    await adminClient?.query(`CREATE DATABASE ${SCRATCH}`);
    app = await createServer({
      ...baseOverrides(scratchUrl(SCRATCH)),
      adminEmail: BOOTSTRAP_EMAIL,
      adminPassword: BOOTSTRAP_PASSWORD,
      // ON for this block: the invariant-8 tests (REST/GraphQL/API-key access
      // is never gated by claim state) are only meaningful under enforcement.
      requireAuth: true,
      // ON so the "claim as an anonymous guest" case has a guest session to
      // attempt with.
      anonymousAuth: true,
    });
    const adminRole = await app.roleManager.getByName('admin');
    const holders = await app.roleManager.getUsersForRole((adminRole as { id: string }).id);
    bootstrapUserId = holders[0] as string;

    // A second, genuinely low-privileged (no role) account — created the same
    // administrative way the bootstrap itself creates the admin, purely as
    // test setup for the "tampered body" case below. It is NEVER marked
    // pending-claim; only the bootstrap-created admin ever is.
    lowPrivEmail = 'lowpriv@ion.test';
    lowPrivPassword = 'lowpriv-Passw0rd';
    await app.authProvider.createUser({ email: lowPrivEmail, password: lowPrivPassword });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await drainThenDrop(SCRATCH);
  }, 60_000);

  it('1. reaching the claim endpoint without any session fails closed (401)', async () => {
    if (!app) throw new Error('Server not booted');
    const res = await request(app, 'POST', '/api/v1/admin-claim', {
      body: {
        name: 'Nobody',
        newPassword: 'attacker-Passw0rd',
        confirmPassword: 'attacker-Passw0rd',
      },
    });
    expect(res.status).toBe(401);
  });

  it('1b. the claim status read also requires a session (401)', async () => {
    if (!app) throw new Error('Server not booted');
    const res = await request(app, 'GET', '/api/v1/admin-claim/status');
    expect(res.status).toBe(401);
  });

  it("3. a tampered body cannot aim the claim at another account — the target is always the caller's own session", async () => {
    if (!app) throw new Error('Server not booted');
    const lowPrivSignin = await signIn(app, lowPrivEmail, lowPrivPassword);
    expect(lowPrivSignin.status).toBe(200);

    // The low-priv caller's OWN account has no pending marker, so this must
    // 409 regardless of what the body claims — the bogus `userId`/`email`
    // fields (the endpoint's schema doesn't even declare them) are inert.
    const res = await request(app, 'POST', '/api/v1/admin-claim', {
      body: {
        name: 'Hijacked',
        newPassword: 'hijack-Passw0rd',
        confirmPassword: 'hijack-Passw0rd',
        userId: bootstrapUserId,
        email: BOOTSTRAP_EMAIL,
      },
      headers: lowPrivSignin.authHeader,
    });
    expect(res.status).toBe(409);

    // The real admin account is untouched: still pending, still the env
    // password.
    expect(await app.adminClaimService.isPendingClaim(bootstrapUserId)).toBe(true);
    const stillWorks = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(stillWorks.status).toBe(200);
  });

  it('4. marking/clearing an arbitrary account pending-claim via the config API is refused (403)', async () => {
    if (!app) throw new Error('Server not booted');
    const adminSignin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(adminSignin.status).toBe(200);

    // Even the admin's OWN (fully privileged, manage:config) session cannot
    // write the reserved namespace directly.
    const forgeAttempt = await request(
      app,
      'PUT',
      '/api/v1/config/admin-claim.pending.some-victim',
      {
        body: { value: true },
        headers: adminSignin.authHeader,
      },
    );
    expect(forgeAttempt.status).toBe(403);

    const clearAttempt = await request(
      app,
      'DELETE',
      `/api/v1/config/admin-claim.pending.${bootstrapUserId}`,
      { headers: adminSignin.authHeader },
    );
    expect(clearAttempt.status).toBe(403);
    // The real marker is untouched by the refused delete.
    expect(await app.adminClaimService.isPendingClaim(bootstrapUserId)).toBe(true);

    // The dynamic data API cannot address `_ion_config` at all — it is not a
    // registered Ion object (ADR-009), so this is a plain 404, not a 403.
    const dataPlane = await request(app, 'GET', '/api/v1/data/_ion_config', {
      headers: adminSignin.authHeader,
    });
    expect(dataPlane.status).toBe(404);
  });

  it('5. claiming as an anonymous guest fails closed (403)', async () => {
    if (!app) throw new Error('Server not booted');
    const guest = await request(app, 'POST', '/api/auth/sign-in/anonymous');
    expect(guest.status).toBe(200);
    const token = (guest.body as { token?: string }).token;
    expect(token).toBeTruthy();

    const res = await request(app, 'POST', '/api/v1/admin-claim', {
      body: { name: 'Guest', newPassword: 'guest-Passw0rd', confirmPassword: 'guest-Passw0rd' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await app.adminClaimService.isPendingClaim(bootstrapUserId)).toBe(true);
  });

  it('8a. a still-pending-claim admin session already has full REST/GraphQL access — claim state does not gate it', async () => {
    if (!app) throw new Error('Server not booted');
    const signin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(signin.status).toBe(200);

    // Confirm we really are still pending at this point in the suite.
    const me = await request(app, 'GET', '/api/v1/me', { headers: signin.authHeader });
    expect(me.body.pendingClaim).toBe(true);

    // REST admin surface (RBAC-governed; requireAuth: true in this block).
    const roles = await request(app, 'GET', '/api/v1/roles', { headers: signin.authHeader });
    expect(roles.status).toBe(200);

    // Dynamic data surface (a 200 empty list — no objects defined — proves
    // the request was authorized, not rejected for claim state).
    const objects = await request(app, 'GET', '/api/v1/schema/objects', {
      headers: signin.authHeader,
    });
    expect(objects.status).toBe(200);

    // GraphQL surface.
    const gql = await request(app, 'POST', '/api/v1/graphql', {
      body: { query: '{ __typename }' },
      headers: signin.authHeader,
    });
    expect(gql.status).toBe(200);
    expect((gql.body as { data?: { __typename?: string } }).data?.__typename).toBe('Query');
  });

  it('8b. an API key bound to the pending-claim admin works regardless of claim state', async () => {
    if (!app) throw new Error('Server not booted');
    expect(await app.adminClaimService.isPendingClaim(bootstrapUserId)).toBe(true);

    const created = await app.apiKeyManager.create({ name: 'svc-key', userId: bootstrapUserId });
    const res = await request(app, 'GET', '/api/v1/roles', {
      headers: { 'x-api-key': created.key },
    });
    expect(res.status).toBe(200);
  });

  it('7. two concurrent claim attempts on the same pending account — only the first succeeds', async () => {
    if (!app) throw new Error('Server not booted');
    const signin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(signin.status).toBe(200);

    const [resA, resB] = await Promise.all([
      request(app, 'POST', '/api/v1/admin-claim', {
        body: {
          name: 'Racer A',
          newPassword: 'racerA-Passw0rd',
          confirmPassword: 'racerA-Passw0rd',
        },
        headers: signin.authHeader,
      }),
      request(app, 'POST', '/api/v1/admin-claim', {
        body: {
          name: 'Racer B',
          newPassword: 'racerB-Passw0rd',
          confirmPassword: 'racerB-Passw0rd',
        },
        headers: signin.authHeader,
      }),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const winnerPassword = resA.status === 200 ? 'racerA-Passw0rd' : 'racerB-Passw0rd';
    const loserPassword = resA.status === 200 ? 'racerB-Passw0rd' : 'racerA-Passw0rd';

    const winnerSignin = await signIn(app, BOOTSTRAP_EMAIL, winnerPassword);
    expect(winnerSignin.status).toBe(200);
    const loserSignin = await signIn(app, BOOTSTRAP_EMAIL, loserPassword);
    expect(loserSignin.status).not.toBe(200);

    // The marker is gone — a third attempt (even with a valid, now-claimed
    // session) also fails closed. Never a second reset.
    const third = await request(app, 'POST', '/api/v1/admin-claim', {
      body: { name: 'Racer C', newPassword: 'racerC-Passw0rd', confirmPassword: 'racerC-Passw0rd' },
      headers: winnerSignin.authHeader,
    });
    expect(third.status).toBe(409);
  });
});

describe('6. Wipe without re-supplying the env secret cannot regain a claimable admin', () => {
  const SCRATCH = `ion_claim_wipe_${randomBytes(6).toString('hex')}`;
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

  it('wiping users then rebooting WITHOUT ION_ADMIN_* leaves zero users and never regrants admin', async () => {
    if (!app) throw new Error('Server not booted');
    await app.close();
    const wipe = new pg.Client({ connectionString: scratchUrl(SCRATCH) });
    await wipe.connect();
    await wipe.query('DELETE FROM "_ion_user_roles"');
    await wipe.query('DELETE FROM "session"');
    await wipe.query('DELETE FROM "account"');
    await wipe.query('DELETE FROM "user"');
    await wipe.end();

    // Case (a) — the realistic deployment posture: the operator kept
    // ION_DISABLE_SIGNUP=true set independently of the admin vars (the docs
    // recommend the env bootstrap "for anything public", which locks signup
    // by default). Rebooting WITHOUT the admin secret leaves zero users, no
    // credential to sign in with, and signup still 403 — the durable
    // `bootstrap.completed` marker survived the wipe (pre-existing #26
    // behavior), so there is no way back in without restoring the secret.
    app = await createServer({ ...baseOverrides(scratchUrl(SCRATCH)), disableSignup: true });
    expect(await userCount(app)).toBe(0);
    const signin = await signIn(app, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    expect(signin.status).not.toBe(200);
    const lockedSignup = await request(app, 'POST', '/api/auth/sign-up/email', {
      body: { email: 'attacker@ion.test', password: 'attacker-Passw0rd', name: 'Attacker' },
    });
    expect(lockedSignup.status).toBe(403);
    expect(await userCount(app)).toBe(0);

    // Case (b) — belt and suspenders for a misconfigured deployment where
    // ION_DISABLE_SIGNUP was never set independently, so it reverts to its
    // own (open) default the moment the admin vars are omitted: even then, a
    // walk-in signup can never become admin or land pending-claim, because
    // `grantAdminIfFirstUser`'s OWN durable marker check (audit V4, See
    // RoleManager) is independent of the signup-lock config entirely.
    await app.close();
    app = await createServer(baseOverrides(scratchUrl(SCRATCH)));
    expect(app.config.disableSignup).toBe(false);
    const openSignup = await request(app, 'POST', '/api/auth/sign-up/email', {
      body: { email: 'walkin@ion.test', password: 'walkin-Passw0rd', name: 'Walk In' },
    });
    expect(openSignup.status).toBe(200);
    const walkInId = (openSignup.body.user as Json).id as string;
    const adminRole = await app.roleManager.getByName('admin');
    const holders = await app.roleManager.getUsersForRole((adminRole as { id: string }).id);
    expect(holders).not.toContain(walkInId);
    expect(await app.adminClaimService.isPendingClaim(walkInId)).toBe(false);
  }, 120_000);
});
