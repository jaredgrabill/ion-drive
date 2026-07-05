import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Input, Label } from '../components/ui';
import { AuthError, auth } from '../lib/auth';

/**
 * Login / first-run sign-up screen. The very first account created becomes an
 * admin automatically (enforced by the backend), so a fresh install shows the
 * sign-up form as the way in.
 */
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
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <div className="p-6">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold tracking-tight">⚡ Ion Drive</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === 'signin'
                ? 'Sign in to the admin console'
                : 'Create the first admin account'}
            </p>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === 'signup' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" disabled={busy} className="mt-2">
              {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <button
            type="button"
            className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground"
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
      </Card>
    </div>
  );
}
