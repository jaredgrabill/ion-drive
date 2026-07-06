/**
 * Router — code-based TanStack Router setup.
 *
 * The root route gates on the session: while loading it shows a spinner, when
 * signed out it renders the Login screen, and when signed in it renders the
 * AppShell (whose Outlet hosts the child routes below). Phase 8 added the
 * Tasks/Blocks/Logs/Metrics/API Keys routes and the task detail view.
 */

import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { type FC, lazy } from 'react';
import { AppShell } from './components/layout';
import { Spinner } from './components/ui';
import { useSession } from './lib/session';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { ObjectsList } from './pages/ObjectsList';
import { Roles } from './pages/Roles';
import { Secrets } from './pages/Secrets';
import { SettingsPage } from './pages/Settings';
import { Users } from './pages/Users';

// Secondary pages are code-split; the AppShell's Suspense boundary shows a
// spinner during chunk load. Dashboard/Objects stay eager (first paint).
const ApiKeys = lazy(() => import('./pages/api-keys').then((m) => ({ default: m.ApiKeys })));
// ObjectDetail carries the DataGrid (TanStack Table + virtualizer) — split it.
const ObjectDetail = lazy(() =>
  import('./pages/ObjectDetail').then((m) => ({ default: m.ObjectDetail })),
);
const Blocks = lazy(() => import('./pages/blocks').then((m) => ({ default: m.Blocks })));
const Logs = lazy(() => import('./pages/logs').then((m) => ({ default: m.Logs })));
const Metrics = lazy(() => import('./pages/metrics').then((m) => ({ default: m.Metrics })));
const TaskDetail = lazy(() =>
  import('./pages/task-detail').then((m) => ({ default: m.TaskDetail })),
);
const Tasks = lazy(() => import('./pages/tasks').then((m) => ({ default: m.Tasks })));

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
  route('/blocks', Blocks),
  route('/tasks', Tasks),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: TaskDetail,
  }),
  route('/users', Users),
  route('/roles', Roles),
  route('/api-keys', ApiKeys),
  route('/secrets', Secrets),
  route('/logs', Logs),
  route('/metrics', Metrics),
  route('/settings', SettingsPage),
]);

// The SPA is served under /admin (Vite `base`); in vitest BASE_URL is '/'.
const basepath = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

export const router = createRouter({ routeTree, defaultPreload: 'intent', basepath });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Re-export Outlet for convenience in the shell.
export { Outlet };
