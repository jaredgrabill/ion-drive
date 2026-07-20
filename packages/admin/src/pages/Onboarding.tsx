/**
 * Onboarding — the one-time admin "claim" screen (issue #32).
 *
 * Shown instead of the app shell for a session whose account was created by
 * env-var admin bootstrap (`ION_ADMIN_EMAIL`/`ION_ADMIN_PASSWORD`) and has not
 * yet completed first-login setup — see `RootGate` in `router.tsx`, which
 * renders this for every route until the claim completes, so there is no way
 * to reach any other admin surface first.
 *
 * Submitting sets a real display name and rotates the account off the
 * bootstrap password via `POST /api/v1/admin-claim`; on success the `/me`
 * query is invalidated, `pendingClaim` flips to false, and `RootGate` swaps
 * straight to the normal app shell — no separate redirect needed.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { LogoMark } from '../components/layout/logo';
import { Button, Input, Label } from '../components/ui';
import { ApiError, api } from '../lib/api';

export function Onboarding() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setBusy(true);
    try {
      await api.completeAdminClaim({ name, newPassword, confirmPassword });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="starfield flex min-h-screen flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md">
        <div className="p-6">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <LogoMark size={40} />
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">
                Finish setting up your account
              </h1>
              <p className="mt-1 text-sm text-white/60">
                You signed in with the bootstrap password from your server's environment. Choose
                your name and a new password to finish claiming this admin account — the bootstrap
                password stops working once you do.
              </p>
            </div>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="claim-name" className="text-white/80">
                Display name
              </Label>
              <Input
                id="claim-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
                autoComplete="name"
                className="border-white/15 bg-white/5 text-white placeholder:text-white/30"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="claim-new-password" className="text-white/80">
                New password
              </Label>
              <Input
                id="claim-new-password"
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className="border-white/15 bg-white/5 text-white placeholder:text-white/30"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="claim-confirm-password" className="text-white/80">
                Confirm new password
              </Label>
              <Input
                id="claim-confirm-password"
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className="border-white/15 bg-white/5 text-white placeholder:text-white/30"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-ion-red">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={busy}
              className="mt-2 bg-white text-black shadow-md transition-transform hover:scale-[1.01] hover:bg-white/90"
            >
              {busy ? 'Please wait…' : 'Claim this account'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
Onboarding.displayName = 'Onboarding';
