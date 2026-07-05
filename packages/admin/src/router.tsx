/**
 * Router — code-based TanStack Router setup.
 *
 * The root route gates on the session: while loading it shows a spinner, when
 * signed out it renders the Login screen, and when signed in it renders the
 * AppShell (whose Outlet hosts the child routes below).
 */

import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { FC } from 'react';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui';
import { useSession } from './lib/session';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { ObjectDetail } from './pages/ObjectDetail';
import { ObjectsList } from './pages/ObjectsList';
import { Roles } from './pages/Roles';
import { Secrets } from './pages/Secrets';
import { SettingsPage } from './pages/Settings';
import { Users } from './pages/Users';

function RootGate() {
  const { isLoading, isAuthenticated } = useSession();
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (!isAuthenticated) return <Login />;
  return <AppShell />;
}

const rootRoute = createRootRoute({ component: RootGate });

const route = (path: string, component: FC) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

const routeTree = rootRoute.addChildren([
  route('/', Dashboard),
  route('/objects', ObjectsList),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/objects/$name',
    component: ObjectDetail,
  }),
  route('/users', Users),
  route('/roles', Roles),
  route('/secrets', Secrets),
  route('/settings', SettingsPage),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Re-export Outlet for convenience in the shell.
export { Outlet };
