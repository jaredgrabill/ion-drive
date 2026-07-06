/**
 * Login — sign-in / first-run sign-up over a CSS star-field.
 *
 * The very first account created becomes an admin automatically (enforced
 * by the backend), so a fresh install leads with a welcoming "Set up your
 * Ion Drive" flow. The backdrop is the pure-CSS `.starfield` utility (no
 * canvas/JS); the card is glass-morphism (`backdrop-blur`) with the glowing
 * LogoMark above the title.
 */

import { useQueryClient } from '@tanstack/react-query';
import { Github } from 'lucide-react';
import { useState } from 'react';
import { LogoMark } from '../components/layout/logo';
import { Button, Input, Label } from '../components/ui';
import { AuthError, auth } from '../lib/auth';

export function Login() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') await auth.signUp(email, password, name || email);
      else await auth.signIn(email, password);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Something went wrong');
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
                {mode === 'signin' ? 'Ion Drive' : 'Set up your Ion Drive'}
              </h1>
              <p className="mt-1 text-sm text-white/60">
                {mode === 'signin'
                  ? 'Sign in to the admin console'
                  : 'Create the first admin account — you own this instance.'}
              </p>
            </div>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === 'signup' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name" className="text-white/80">
                  Name
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  className="border-white/15 bg-white/5 text-white placeholder:text-white/30"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email" className="text-white/80">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="border-white/15 bg-white/5 text-white placeholder:text-white/30"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password" className="text-white/80">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
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
              {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <button
            type="button"
            className="mt-4 w-full text-center text-sm text-white/50 transition-colors hover:text-white/80"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setError(null);
            }}
          >
            {mode === 'signin'
              ? 'First time? Create an account'
              : 'Already have an account? Sign in'}
          </button>
        </div>
      </div>

      <a
        href="https://github.com/jaredgrabill/ion-drive"
        target="_blank"
        rel="noreferrer"
        className="mt-6 flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
      >
        <Github className="h-3.5 w-3.5" aria-hidden />
        Powered by Ion Drive · Open Source
      </a>
    </div>
  );
}
Login.displayName = 'Login';
