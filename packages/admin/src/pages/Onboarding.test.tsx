/**
 * Onboarding (claim screen) tests — issue #32.
 *
 * Covers the client-side half of the claim flow: the form never lets a
 * password/confirmation mismatch reach the server, a successful claim
 * invalidates the `me` query (which is what flips `RootGate` from Onboarding
 * to the app shell — see lib/root-view.test.ts for that decision itself),
 * and a server-side rejection surfaces inline.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { Onboarding } from './Onboarding';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: { ...actual.api, completeAdminClaim: vi.fn() },
  };
});

function renderOnboarding() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <Onboarding />
    </QueryClientProvider>,
  );
  return { queryClient };
}

async function fillAndSubmit(opts: {
  name?: string;
  newPassword: string;
  confirmPassword: string;
}) {
  const user = userEvent.setup();
  if (opts.name !== undefined) {
    await user.type(screen.getByLabelText('Display name'), opts.name);
  }
  await user.type(screen.getByLabelText('New password'), opts.newPassword);
  await user.type(screen.getByLabelText('Confirm new password'), opts.confirmPassword);
  await user.click(screen.getByRole('button', { name: /claim this account/i }));
}

describe('Onboarding', () => {
  it('renders the name, new password, and confirm password fields', () => {
    renderOnboarding();
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /claim this account/i })).toBeInTheDocument();
  });

  it('rejects a mismatched confirmation without calling the API', async () => {
    renderOnboarding();
    await fillAndSubmit({
      name: 'Ada Lovelace',
      newPassword: 'a-strong-password',
      confirmPassword: 'a-different-password',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match');
    expect(api.completeAdminClaim).not.toHaveBeenCalled();
  });

  it('submits name + newPassword + confirmPassword and invalidates the me query on success', async () => {
    vi.mocked(api.completeAdminClaim).mockResolvedValueOnce({ success: true });
    const { queryClient } = renderOnboarding();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await fillAndSubmit({
      name: 'Ada Lovelace',
      newPassword: 'a-strong-password',
      confirmPassword: 'a-strong-password',
    });

    expect(api.completeAdminClaim).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      newPassword: 'a-strong-password',
      confirmPassword: 'a-strong-password',
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me'] });
    });
  });

  it('surfaces a server-side rejection (e.g. already claimed) inline', async () => {
    vi.mocked(api.completeAdminClaim).mockRejectedValueOnce(
      new ApiError('This account has no pending claim to complete', 409),
    );
    renderOnboarding();

    await fillAndSubmit({
      name: 'Ada Lovelace',
      newPassword: 'a-strong-password',
      confirmPassword: 'a-strong-password',
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account has no pending claim to complete',
    );
  });
});
