import { describe, expect, it } from 'vitest';
import { AuthError } from './auth.js';
import { IonDriveClient } from './client.js';

/** Builds a fake `fetch` that records calls and returns a canned response. */
function fakeFetch(response: {
  status?: number;
  json?: unknown;
  body?: string;
}): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    const text =
      response.body ?? (response.json !== undefined ? JSON.stringify(response.json) : '');
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('ion.auth.signInAnonymously()', () => {
  it('POSTs to /api/auth/sign-in/anonymous with credentials and returns token + user', async () => {
    const { fetch, calls } = fakeFetch({
      json: { token: 'sess_1', user: { id: 'u1', email: 'temp-x@x.dev', isAnonymous: true } },
    });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000/', fetch });

    const result = await ion.auth.signInAnonymously();

    expect(result.token).toBe('sess_1');
    expect(result.user.id).toBe('u1');
    expect(result.user.isAnonymous).toBe(true);
    const call = calls[0];
    expect(call?.url).toBe('http://x:3000/api/auth/sign-in/anonymous');
    expect(call?.init.method).toBe('POST');
    // Cookies must persist in browsers, including cross-origin setups.
    expect(call?.init.credentials).toBe('include');
  });

  it('sends the configured API key / extra headers', async () => {
    const { fetch, calls } = fakeFetch({ json: { token: 't', user: { id: 'u' } } });
    const ion = new IonDriveClient({
      baseUrl: 'http://x:3000',
      apiKey: 'iond_abc',
      headers: { 'x-custom': 'yes' },
      fetch,
    });
    await ion.auth.signInAnonymously();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('iond_abc');
    expect(headers['x-custom']).toBe('yes');
  });

  it('maps a 404 to an actionable "not enabled" AuthError', async () => {
    const { fetch } = fakeFetch({ status: 404, json: { message: 'Not Found' } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    const err = await ion.auth.signInAnonymously().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(404);
    expect((err as AuthError).message).toContain('ION_ANONYMOUS_AUTH');
  });

  it('surfaces the server message on other errors', async () => {
    const { fetch } = fakeFetch({ status: 429, json: { message: 'Rate limit exceeded' } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    const err = await ion.auth.signInAnonymously().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(429);
    expect((err as AuthError).message).toBe('Rate limit exceeded');
  });
});
