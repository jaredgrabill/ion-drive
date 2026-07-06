/**
 * AppShell — the authenticated application frame.
 *
 * Composes Sidebar + Header + the routed page (`<Outlet />`), owns the
 * command-palette open state (bound to ⌘K / Ctrl+K via
 * `use-keyboard-shortcut`), and wraps the page area in an error boundary so a
 * crashing page never blanks the whole console.
 */

import { Outlet } from '@tanstack/react-router';
import { Component, type ErrorInfo, type ReactNode, Suspense, useState } from 'react';
import { useKeyboardShortcut } from '../../hooks';
import { Button, Card, CardContent, Spinner } from '../ui';
import { CommandPalette } from './command-palette';
import { Header } from './header';
import { Sidebar } from './sidebar';

// --- Page error boundary ----------------------------------------------

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render errors in the routed page and offers a retry. */
class PageErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Rendering already recovered to the fallback; nothing else to do.
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <Card className="max-w-md text-center">
            <CardContent className="flex flex-col items-center gap-3 p-8">
              <p className="text-lg font-semibold">Something went wrong</p>
              <p className="text-sm text-muted-foreground">{this.state.error.message}</p>
              <Button onClick={() => this.setState({ error: null })}>Try again</Button>
            </CardContent>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Component -------------------------------------------------------

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useKeyboardShortcut('k', () => setPaletteOpen(true), { meta: true, allowInInputs: true });

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-y-auto p-6">
          <PageErrorBoundary>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner className="h-8 w-8" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </PageErrorBoundary>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
AppShell.displayName = 'AppShell';
