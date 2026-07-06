/**
 * App — provider stack for the admin console.
 *
 * Wires TanStack Query, the router, the shared Radix TooltipProvider, and
 * the sonner toast outlet. Query defaults keep data mildly fresh without
 * aggressive refetching (this is an admin tool, not a trading terminal).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Toaster, TooltipProvider } from './components/ui';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
App.displayName = 'App';
