/**
 * Auth namespace — a deliberately minimal surface over the server's Better
 * Auth endpoints (`/api/auth/*`). Ion Drive's SDK is not a full auth client
 * (Better Auth ships its own for that); this covers the one flow the platform
 * exposes as a product feature: anonymous (guest) sign-in.
 *
 *   const ion = new IonDriveClient({ baseUrl: 'http://localhost:3000' });
 *   const { user } = await ion.auth.signInAnonymously();
 *   // The session cookie is set by the server; same-origin browser requests
 *   // (and any fetch with credentials) are now authenticated as the guest.
 *
 * Requires `ION_ANONYMOUS_AUTH=true` on the server — otherwise the endpoint
 * responds 404 and this call rejects with {@link AuthError}.
 */

/** The guest user returned by anonymous sign-in. */
export interface AnonymousUser {
  id: string;
  email: string;
  name: string;
  isAnonymous?: boolean;
  [key: string]: unknown;
}

export interface SignInAnonymouslyResult {
  /** Better Auth session token (also set as an httpOnly cookie). */
  token: string;
  user: AnonymousUser;
}

/** What the auth API needs from the client (kept minimal for testability). */
export interface AuthTransport {
  baseUrl: string;
  fetchImpl: typeof fetch;
  headers: () => Record<string, string>;
}

/** Error thrown when an auth endpoint responds non-2xx. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthApi {
  constructor(private readonly transport: AuthTransport) {}

  /**
   * Creates an anonymous (guest) user and session
   * (`POST /api/auth/sign-in/anonymous`). The server sets the session cookie
   * on the response (`credentials: 'include'` is passed so browsers persist it
   * cross-origin too); the returned token identifies the session for
   * non-cookie transports.
   */
  async signInAnonymously(): Promise<SignInAnonymouslyResult> {
    const res = await this.transport.fetchImpl(
      `${this.transport.baseUrl}/api/auth/sign-in/anonymous`,
      {
        method: 'POST',
        headers: { accept: 'application/json', ...this.transport.headers() },
        credentials: 'include',
      },
    );
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const message =
        res.status === 404
          ? 'Anonymous sign-in is not enabled on this server (set ION_ANONYMOUS_AUTH=true)'
          : ((parsed && typeof parsed === 'object' && 'message' in parsed
              ? String((parsed as { message: unknown }).message)
              : undefined) ?? `Anonymous sign-in failed with status ${res.status}`);
      throw new AuthError(message, res.status, parsed);
    }
    return parsed as SignInAnonymouslyResult;
  }
}
