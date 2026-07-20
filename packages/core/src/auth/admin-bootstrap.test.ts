/**
 * Unit tests for the env admin bootstrap credential resolution (issue #26).
 * The end-to-end behavior (account creation, first-admin grant, signup lock,
 * second-boot no-op) lives in integration/admin-bootstrap.integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { resolveAdminBootstrapCredentials } from './admin-bootstrap.js';

const failRead = (): string => {
  throw new Error('readFile should not be called');
};

describe('resolveAdminBootstrapCredentials', () => {
  it('returns undefined when no bootstrap variable is set (first-signup-wins unchanged)', () => {
    expect(resolveAdminBootstrapCredentials({}, failRead)).toBeUndefined();
  });

  it('resolves email + inline password', () => {
    const creds = resolveAdminBootstrapCredentials(
      { adminEmail: 'ops@example.com', adminPassword: 'hunter2hunter2' },
      failRead,
    );
    expect(creds).toEqual({ email: 'ops@example.com', password: 'hunter2hunter2' });
  });

  it('resolves email + password file, trimming surrounding whitespace', () => {
    const creds = resolveAdminBootstrapCredentials(
      { adminEmail: 'ops@example.com', adminPasswordFile: '/run/secrets/pw' },
      (path) => {
        expect(path).toBe('/run/secrets/pw');
        return '  s3cret-from-mount\n';
      },
    );
    expect(creds).toEqual({ email: 'ops@example.com', password: 's3cret-from-mount' });
  });

  it('rejects when both password sources are set', () => {
    expect(() =>
      resolveAdminBootstrapCredentials(
        { adminEmail: 'a@b.co', adminPassword: 'x', adminPasswordFile: '/f' },
        failRead,
      ),
    ).toThrow(/not both/);
  });

  it('rejects a password without an email', () => {
    expect(() => resolveAdminBootstrapCredentials({ adminPassword: 'x' }, failRead)).toThrow(
      /ION_ADMIN_EMAIL is not/,
    );
    expect(() => resolveAdminBootstrapCredentials({ adminPasswordFile: '/f' }, failRead)).toThrow(
      /ION_ADMIN_EMAIL is not/,
    );
  });

  it('rejects an email without any password source', () => {
    expect(() => resolveAdminBootstrapCredentials({ adminEmail: 'a@b.co' }, failRead)).toThrow(
      /ION_ADMIN_PASSWORD or ION_ADMIN_PASSWORD_FILE/,
    );
  });

  it('wraps unreadable password files in a message naming the variable, not a secret', () => {
    expect(() =>
      resolveAdminBootstrapCredentials(
        { adminEmail: 'a@b.co', adminPasswordFile: '/missing' },
        () => {
          throw new Error('ENOENT: no such file');
        },
      ),
    ).toThrow(/ION_ADMIN_PASSWORD_FILE \(\/missing\).*ENOENT/);
  });

  it('rejects a password file that is empty after trimming', () => {
    expect(() =>
      resolveAdminBootstrapCredentials(
        { adminEmail: 'a@b.co', adminPasswordFile: '/f' },
        () => '\n \n',
      ),
    ).toThrow(/empty after trimming/);
  });
});
