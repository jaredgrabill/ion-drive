/**
 * The blocks browser island — the only JS-rendered surface on the site
 * (loaded on `/blocks` routes only; the 404 page mounts it too as the GitHub
 * Pages deep-link fallback, where it renders nothing unless the path is a
 * `/blocks/*` one).
 *
 * A ~40-line pushState router handles `/blocks`, `/blocks/registries`, and
 * `/blocks/<name>`; the registry index is fetched once and shared. Failure
 * classification drives the degradation matrix: index unreachable ⇒ the full
 * offline notice; a legacy or future-versioned index ⇒ the reader's exact
 * message; everything below the index degrades per-section.
 */

import { useCallback, useEffect, useState } from 'react';
import { BlockPanel } from './BlockPanel.js';
import { Directory } from './Directory.js';
import { Registries } from './Registries.js';
import { RegistryOfflineError, getRegistryUrl, loadIndex } from './registry/client.js';
import { RegistryError, type RegistryIndexDoc } from './registry/reader.js';

type Route = { kind: 'directory' } | { kind: 'registries' } | { kind: 'block'; name: string };

/** Parses a pathname into a browser route; null means "not a /blocks path". */
export function parseRoute(pathname: string): Route | null {
  const clean = pathname.replace(/\/+$/, '');
  if (clean === '/blocks' || clean === '')
    return pathname.startsWith('/blocks') ? { kind: 'directory' } : null;
  if (!clean.startsWith('/blocks/')) return null;
  const rest = decodeURIComponent(clean.slice('/blocks/'.length));
  if (rest === '') return { kind: 'directory' };
  if (rest === 'registries') return { kind: 'registries' };
  return { kind: 'block', name: rest };
}

type IndexState =
  | { status: 'loading' }
  | { status: 'offline'; message: string }
  | { status: 'unusable'; message: string }
  | { status: 'ready'; index: RegistryIndexDoc };

export interface BlocksBrowserProps {
  /** Overridable for tests/previews; defaults to the build-time registry URL. */
  registryUrl?: string;
}

export function BlocksBrowser({ registryUrl }: BlocksBrowserProps) {
  const indexUrl = registryUrl ?? getRegistryUrl();
  const [route, setRoute] = useState<Route | null>(() =>
    typeof window === 'undefined' ? { kind: 'directory' } : parseRoute(window.location.pathname),
  );
  const [state, setState] = useState<IndexState>({ status: 'loading' });

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(parseRoute(path));
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const isBlocksRoute = route !== null;
  useEffect(() => {
    if (!isBlocksRoute) return;
    let cancelled = false;
    loadIndex(indexUrl)
      .then((index) => {
        if (!cancelled) setState({ status: 'ready', index });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof RegistryOfflineError) {
          setState({ status: 'offline', message: err.message });
        } else if (err instanceof RegistryError) {
          setState({ status: 'unusable', message: err.message });
        } else {
          setState({ status: 'unusable', message: (err as Error).message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [indexUrl, isBlocksRoute]);

  // Mounted on a non-/blocks page (the 404 fallback): render nothing.
  if (route === null) return null;

  if (state.status === 'loading') {
    return (
      <div className="container blocks-page">
        <output>loading registry…</output>
      </div>
    );
  }

  if (state.status === 'offline' || state.status === 'unusable') {
    return (
      <div className="container blocks-page">
        <div className="notice error" role="alert">
          <h3>{state.status === 'offline' ? 'Registry unreachable' : 'Registry not readable'}</h3>
          <p>{state.message}</p>
          <p>
            The rest of the site works without it — try the{' '}
            <a href="/docs/getting-started/">docs</a>, or install blocks straight from the CLI:{' '}
            <code>npx ion-drive list</code>.
          </p>
        </div>
      </div>
    );
  }

  const { index } = state;
  return (
    <div className="container blocks-page">
      {route.kind === 'directory' && (
        <Directory index={index} indexUrl={indexUrl} onNavigate={navigate} />
      )}
      {route.kind === 'registries' && (
        <Registries index={index} indexUrl={indexUrl} onNavigate={navigate} />
      )}
      {route.kind === 'block' && (
        <BlockPanel index={index} indexUrl={indexUrl} name={route.name} onNavigate={navigate} />
      )}
    </div>
  );
}
