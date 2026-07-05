/**
 * Auth client — thin wrapper over the Better Auth HTTP endpoints (`/api/auth`).
 *
 * The browser sends the Origin header and session cookie automatically, so this
 * stays dependency-free. Session *state* (including roles) is read from the core
 * `/api/v1/me` endpoint via the api client, so there is no separate SDK.
 */

export class AuthError extends Error {}

async function authRequest(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`/api/auth${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthError(
      (data as { message?: string })?.message ?? `Authentication failed (${res.status})`,
    );
  }
  return data;
}

export const auth = {
  signUp: (email: string, password: string, name: string) =>
    authRequest('/sign-up/email', { email, password, name }),
  signIn: (email: string, password: string) => authRequest('/sign-in/email', { email, password }),
  signOut: () => authRequest('/sign-out', {}),
};
